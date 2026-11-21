const codingPlanOrigins = new Map([['zai', 'https://api.z.ai'], ['bigmodel', 'https://bigmodel.cn']]);

function asUnixSeconds(value) {
  const milliseconds = typeof value === 'string' ? Date.parse(value.trim().replace(' ', 'T')) : value;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  return Math.floor(typeof value === 'string' || milliseconds >= 1e12 ? milliseconds / 1000 : milliseconds);
}

function quotaWindow(limits, unit, number, windowDurationMins) {
  const limit = limits?.find(entry => ['TOKENS_LIMIT', 'CREDIT_LIMIT'].includes(entry?.type) && entry.unit === unit && (number === undefined || entry.number === number));
  if (!Number.isFinite(limit?.percentage)) return null;
  return { usedPercent: limit.percentage, windowDurationMins, resetsAt: asUnixSeconds(limit.nextResetTime) };
}

function codingPlan(subscriptionList) {
  const active = subscriptionList?.find(entry => entry?.status === 'VALID' && entry.inCurrentPeriod === true &&
    [entry.productId, entry.productName].some(value => typeof value === 'string' && /coding|编程/i.test(value)));
  if (!active) return null;
  const renewal = asUnixSeconds(active.nextRenewTime);
  const renews = active.autoRenew === true || active.autoRenew === 1;
  const periodEnd = typeof active.valid === 'string' && active.valid.match(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/g)?.at(-1);
  return {
    name: String(active.productName || active.productId || '').slice(0, 120),
    expiresAt: (renews ? null : renewal) ?? asUnixSeconds(periodEnd),
    renewsAt: renews ? renewal : null
  };
}

export async function readZCodeUsage({ family, authenticate }, fetcher = fetch) {
  const origin = codingPlanOrigins.get(family);
  if (!origin) return { usageMessage: 'ZCode quota is available for individual Coding Plan models.' };
  const signal = AbortSignal.timeout(30000);
  async function account(expectedScope) {
    try {
      const resolved = await authenticate(signal, expectedScope);
      if (typeof resolved?.apiKey === 'string' && resolved.apiKey.trim()) return resolved;
    } catch (error) {
      const code = [error?.code, error?.message].find(value => typeof value === 'string' && /^project_token_[a-z_]+$/.test(value));
      if (code === 'project_token_login_required') throw new Error('Sign in through ZCode and reopen Usage.');
      if (code && code !== 'project_token_scope_invalidated') throw new Error(`ZCode could not verify the account (${code}). Reopen Usage to retry.`);
    }
    throw new Error('ZCode account credentials are unavailable or changed. Sign in through ZCode and reopen usage.');
  }
  const initialAccount = await account();
  const request = async pathname => {
    const response = await fetcher(origin + pathname, {
      headers: { Authorization: initialAccount.apiKey },
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)])
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body?.success === false || body?.code != null && ![0, 200].includes(body.code) || !body?.data) throw new Error('Invalid account usage response.');
    return body.data;
  };
  const [quota, subscriptions] = await Promise.allSettled([
    request('/api/monitor/usage/quota/limit').then(data => {
      if (!Array.isArray(data.limits)) throw new Error('Invalid quota response.');
      return data.limits;
    }),
    request('/api/biz/subscription/list').then(data => {
      if (!Array.isArray(data)) throw new Error('Invalid subscription response.');
      return data;
    })
  ]);
  if (quota.status === 'rejected' && subscriptions.status === 'rejected') throw new Error('ZCode could not read account usage. If your session expired, sign in through ZCode and try again.');
  const currentAccount = await account(initialAccount.accountScope);
  if (initialAccount.accountScope ? currentAccount.accountScope !== initialAccount.accountScope : currentAccount.apiKey !== initialAccount.apiKey) throw new Error('The ZCode account changed. Reopen usage to refresh it.');
  const primary = quotaWindow(quota.value, 3, 5, 300);
  const secondary = quotaWindow(quota.value, 6, undefined, 10080);
  const plan = codingPlan(subscriptions.value);
  return {
    ...(primary || secondary ? { rateLimits: { limitId: 'zcode', primary, secondary } } : {}),
    ...(plan ? { plan } : {}),
    ...(subscriptions.status === 'rejected' ? { usageMessage: 'ZCode plan details are temporarily unavailable.' }
      : !plan ? { usageMessage: 'ZCode reported no active Coding Plan.' }
      : quota.status === 'rejected' ? { usageMessage: 'ZCode account quota is temporarily unavailable.' } : {})
  };
}
