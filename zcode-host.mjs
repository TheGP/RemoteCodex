import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const args = process.argv.slice(1);
if (args[0]?.endsWith('zcode-host.mjs')) args.shift();
let child, runtime, disposed = false, phase = 'launch validation';
const pending = new Map(), authRequests = new Map(), disposers = [];
const writeParent = message => process.stdout.write(JSON.stringify(message) + '\n');
const warning = message => process.stderr.write(message + '\n');
let warned = false;
// Native diagnostics can contain request context. Keep that channel inside the host.
console.log = console.info = console.debug = () => {};
console.warn = console.error = () => { if (!warned) { warned = true; warning('ZCode native runtime reported a warning.'); } };

function close(code = 0, message) {
  if (disposed) return;
  disposed = true;
  if (message) { warning(message); writeParent({ method: 'remote-codex/error', params: { message } }); }
  for (const dispose of disposers) { try { dispose(); } catch {} }
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('ZCode host closed.')); }
  pending.clear();
  for (const request of authRequests.values()) request.controller.abort();
  authRequests.clear();
  try { runtime?.dispose(); } catch {}
  if (child) { child.stdin.end(); child.kill(); }
  const timer = setTimeout(() => { child?.kill('SIGKILL'); process.exit(code); }, 1700);
  if (!child || child.exitCode !== null) { clearTimeout(timer); process.exit(code); }
  else child.once('close', () => { clearTimeout(timer); process.exit(code); });
}
process.on('SIGTERM', () => close());
process.on('SIGINT', () => close());
process.on('uncaughtException', () => close(1, 'ZCode host failed unexpectedly.'));
process.on('unhandledRejection', () => close(1, 'ZCode host failed unexpectedly.'));
process.stdout.on('error', () => close());

function lines(stream, receive) {
  const decoder = new StringDecoder('utf8'); let buffer = '';
  stream.on('data', chunk => {
    buffer += decoder.write(chunk);
    if (buffer.length > 64 * 1024 * 1024) { close(1, 'ZCode returned an oversized protocol message.'); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.trim()) receive(line);
    }
  });
  stream.on('end', () => { buffer += decoder.end(); if (buffer.trim()) receive(buffer); });
}
function writeChild(message) {
  if (disposed || !child || child.stdin.destroyed) throw new Error('ZCode host is not connected.');
  child.stdin.write(JSON.stringify(message) + '\n');
}
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `remote-codex-host:${randomUUID()}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('ZCode host initialization timed out.')); }, 45000);
    pending.set(id, { resolve, reject, timer });
    try { writeChild({ id, method, params }); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24 || args.length !== 2) throw new Error('ZCode requires Node.js 24 and an installed CLI with its native SDK.');
  if (!path.isAbsolute(args[0]) || !path.isAbsolute(args[1]) || args.some(value => value.includes('\0'))) throw new Error('Invalid ZCode launch path.');
  const cli = fs.realpathSync(args[0]), cwd = path.resolve(args[1]);
  if (!fs.statSync(cli).isFile() || !fs.statSync(cwd).isDirectory()) throw new Error('Invalid ZCode launch path.');
  let root = path.dirname(cli);
  while (!fs.existsSync(path.join(root, 'node_modules/@zcode/bootstrap/package.json'))) {
    const parent = path.dirname(root);
    if (parent === root) throw new Error('ZCode native SDK is missing from this CLI installation.');
    root = parent;
  }
  const nativePrefix = pathToFileURL(root + path.sep).href;
  // Source-built SDK packages export TS and retain .js relative specifiers.
  registerHooks({
    resolve(specifier, context, next) {
      try { return next(specifier, context); }
      catch (error) {
        if (error.code === 'ERR_MODULE_NOT_FOUND' && context.parentURL?.startsWith(nativePrefix) && specifier.endsWith('.js')) {
          try { return next(specifier.slice(0, -3) + '.ts', context); } catch {}
        }
        throw error;
      }
    },
    load(url, context, next) {
      if (url.startsWith(nativePrefix) && url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform' }), shortCircuit: true };
      return next(url, context);
    }
  });
  const requireNative = createRequire(fs.realpathSync(path.join(root, 'node_modules/@zcode/bootstrap/dist/index.js')));
  function nativeEntry(name, subpath = '.') {
    const directory = [path.join(root, 'node_modules'), ...(requireNative.resolve.paths(name) || [])].map(directory => path.join(directory, name)).find(directory => fs.existsSync(path.join(directory, 'package.json')));
    if (!directory) throw new Error('ZCode native SDK dependency is missing.');
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    let target = metadata.exports?.[subpath] ?? (subpath === '.' ? metadata.main : null);
    while (target && typeof target === 'object') target = target.import ?? target.node ?? target.default;
    if (typeof target !== 'string') throw new Error('ZCode native SDK is incompatible.');
    return pathToFileURL(path.join(directory, target)).href;
  }
  phase = 'native SDK loading';
  const [bootstrap, auth, security, shared, providerSdk] = await Promise.all([
    import(nativeEntry('@zcode/bootstrap')),
    import(nativeEntry('@zcode/adapters', './auth')),
    import(nativeEntry('@zcode/shared', './credential-security')),
    import(nativeEntry('@zcode/shared')),
    import(nativeEntry('@zcode/provider'))
  ]);
  const env = { ...process.env };
  const dataRoot = path.resolve(env.ZCODE_DATA_BASE_DIR || os.homedir());
  env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ||= path.join(path.dirname(cli), 'provider/zcode-builtin.json');
  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ||= path.join(dataRoot, '.zcode/v2/provider_config.json');
  const credentialFile = auth.resolveSharedZCodeCredentialsPath({ env });
  const credentialCipher = security.createSystemCredentialCipher({ env, filePath: credentialFile });
  phase = 'native account initialization';
  runtime = await bootstrap.startProcessProviderRegistryRuntime(env, { standalone: {
    onAccountInitializationError: () => warning('ZCode account initialization failed; sign in through ZCode and reconnect.'),
    onBuiltinRefreshError: () => warning('ZCode model catalog refresh failed.')
  } });
  if (disposed) { runtime.dispose(); return; }

  function catalog() {
    const registry = runtime.runtime.registryService.getSnapshot()?.registry;
    const models = (registry?.providers || []).filter(provider => provider.config.visibility !== 'hidden').flatMap(provider => provider.models.map(model => {
      const reasoningLevels = [...model.config.optionSpecs.reasoningLevel.values];
      return { providerId: provider.providerId, providerName: provider.providerName || provider.providerId, modelId: model.modelId, reasoningLevels, defaultReasoningLevel: reasoningLevels.at(-1) || '', contextWindow: model.config.properties?.contextWindow };
    }));
    const selection = registry && providerSdk.resolveInitialModelSelection({ configuredDefault: runtime.configuredDefaultModelSelection, registry });
    return { models, defaultModelSelection: selection?.selection || null };
  }
  function validWorkspace(workspace) {
    if (!workspace || workspace.workspaceIdentity || workspace.remoteSessionId || typeof workspace.workspacePath !== 'string' || !path.isAbsolute(workspace.workspacePath) || workspace.workspaceKey !== workspace.workspacePath) return false;
    try { return fs.realpathSync(workspace.workspacePath) === fs.realpathSync(cwd); } catch { return false; }
  }
  async function hostRequest(message) {
    const { id, method, params = {} } = message;
    if (method === 'session/requestRuntimePreferences') {
      writeChild({ id, result: { nativeSearchEnhancementsEnabled: false, askUserQuestionAutoResolutionEnabled: false, memoryEnabled: false, appControlEnabled: false, toolSearchMode: 'off' } });
      return true;
    }
    if (method === 'interaction/requestProviderRuntimeHeaders') {
      let stage = 'request schema', request;
      try {
        const input = shared.zcodeProviderRuntimeHeadersRequestParamsSchema.parse(params);
        stage = 'workspace scope';
        if (!validWorkspace(input.workspace)) throw new Error('Invalid workspace scope.');
        stage = 'model provider scope';
        const provider = runtime.runtime.registryService.getProvider(input.providerId);
        if (input.modelSelection.providerId !== input.providerId || !provider?.models.some(model => model.modelId === input.modelSelection.modelId) || provider.config.access.type !== 'zhipu-account') throw new Error('Invalid auth scope.');
        request = { controller: new AbortController(), sessionId: input.sessionId, workspace: input.workspace };
        authRequests.get(input.requestId)?.controller.abort(); authRequests.set(input.requestId, request);
        stage = 'native credential refresh';
        const result = await runtime.providerRuntimeHeadersPort.refreshBeforeModelRequest({
          providerId: input.providerId, modelId: input.modelSelection.modelId,
          accountAccess: provider.config.access, sessionId: input.sessionId, turnId: input.turnId,
          reason: input.reason, expectedAccountScope: input.expectedAccountScope,
          rejectedProjectTokenFingerprint: input.rejectedProjectTokenFingerprint,
          abortSignal: request.controller.signal
        });
        if (!request.controller.signal.aborted && !disposed) writeChild({ id, result });
      } catch (error) {
        const fixedCode = [error?.code, error?.message].find(value => typeof value === 'string' && /^(?:project_token_[a-z_]+|CREDENTIAL_[A-Z_]+|ZCODE_CREDENTIAL_[A-Z_]+)$/.test(value));
        const kind = ['CodingPlanApiKeyError', 'ProjectAccessTokenError', 'ProjectAccessTokenHttpStatusError', 'ProjectAccessTokenTransientError', 'AbortError', 'TypeError'].includes(error?.name) ? error.name : 'Error';
        const reason = fixedCode || kind;
        if (!request?.controller.signal.aborted && !disposed) writeChild({ id, result: { headersApplied: false, errorMessage: stage === 'native credential refresh' ? `ZCode native authentication failed (${reason}); sign in through ZCode and reconnect.` : `ZCode host authentication validation failed (${stage}).` } });
      } finally {
        if (request && authRequests.get(params.requestId) === request) authRequests.delete(params.requestId);
      }
      return true;
    }
    if (method === 'interaction/requestCredentialCipher') {
      let result;
      try { result = await security.executeCredentialCipherRequest(credentialCipher, params); }
      catch { result = { requestId: typeof params.requestId === 'string' ? params.requestId : '', result: { ok: false, error: { code: 'CREDENTIAL_CIPHER_INVALID_PAYLOAD', message: 'Invalid credential request.' } } }; }
      writeChild({ id, result }); return true;
    }
    if (method === 'interaction/requestOfficialMcpAuthHeaders') {
      writeChild({ id, result: { ok: false, reason: 'official_auth_unavailable' } }); return true;
    }
    if (/^interaction\/.*(?:Auth|Credential|Headers|Token)/.test(method) || ['interaction/browserList', 'interaction/browserExecute'].includes(method)) {
      writeChild({ id, error: { code: -32601, message: 'This ZCode host does not support this request.' } }); return true;
    }
    return false;
  }
  phase = 'CLI startup';
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'app-server', '--cwd', cwd], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.on('error', () => close(1, 'ZCode CLI could not be started.'));
  child.stdin.on('error', () => close(1, 'ZCode CLI connection closed.'));
  child.stderr.on('data', () => {});
  child.on('close', code => { if (!disposed) close(code || 1, 'ZCode CLI connection closed.'); });
  lines(child.stdout, line => {
    let message;
    try { message = JSON.parse(line); }
    catch { close(1, 'ZCode returned invalid protocol data.'); return; }
    const entry = pending.get(message.id);
    if (entry && !message.method) {
      clearTimeout(entry.timer); pending.delete(message.id);
      if (message.error) entry.reject(new Error('ZCode rejected host configuration.')); else entry.resolve(message.result);
      return;
    }
    if (message.method === shared.zcodeProtocolNotifications.providerRuntimeHeadersCancelled) {
      const input = message.params || {}, request = authRequests.get(input.requestId);
      if (request && request.sessionId === input.sessionId && validWorkspace(input.workspace)) {
        request.controller.abort(); authRequests.delete(input.requestId);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      hostRequest(message).then(handled => { if (!handled && !disposed) process.stdout.write(line + '\n'); }).catch(() => close(1, 'ZCode host request failed.'));
      return;
    }
    process.stdout.write(line + '\n');
  });
  lines(process.stdin, line => {
    let message;
    try { message = JSON.parse(line); }
    catch { close(1, 'Invalid ZCode client protocol data.'); return; }
    if (message.method === 'remote-codex/catalog') {
      if (message.id !== undefined) writeParent({ id: message.id, result: catalog() });
      return;
    }
    if (typeof message.method === 'string' && message.method.startsWith('remote-codex/')) {
      if (message.id !== undefined) writeParent({ id: message.id, error: { code: -32601, message: 'Unsupported ZCode host operation.' } });
      return;
    }
    child.stdin.write(line + '\n');
  });
  process.stdin.on('end', () => close());
  process.stdin.on('error', () => close());
  let sync = Promise.resolve();
  function syncAccount() {
    sync = sync.catch(() => {}).then(async () => {
      const account = await runtime.accountSource.read();
      const states = Object.fromEntries(account.providers.entries().map(([id, config]) => {
        const entitled = config.access?.entitled === true;
        if (entitled && runtime.runtime.registryService.getSnapshot()?.config.zcodeBuiltinProviders.get(id)?.access.mode !== 'individual-coding-plan') throw new Error('Unsupported native account state.');
        return [id, { availability: entitled ? 'available' : 'unavailable', entitled, current: entitled, ...account.states?.[id] }];
      }));
      const snapshot = providerSdk.createAccountProviderConfigSnapshot(account.basedOnZCodeBuiltinRevision, account.providers, states);
      await call('provider/updateAccountConfig', { revision: snapshot.revision, basedOnZCodeBuiltinRevision: snapshot.basedOnZCodeBuiltinRevision, providers: Object.fromEntries(snapshot.providers.entries().map(([id, config]) => [id, config.toJSON()])), states });
    });
    return sync;
  }
  disposers.push(runtime.runtime.registryService.onDidChange(() => { syncAccount().catch(() => close(1, 'ZCode account configuration could not be synchronized.')); }));
  phase = 'native account synchronization';
  await call('runtime/capabilities');
  await syncAccount();
  if (!disposed) writeParent({ method: 'remote-codex/ready', params: {} });
}
main().catch(() => close(1, `ZCode host could not initialize (${phase}). Check the CLI installation and sign in through ZCode.`));
