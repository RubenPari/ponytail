#!/usr/bin/env node
// Smoke test for the OpenCode adapter: the plugin's hooks behave against the
// real (structural) OpenCode hook shapes. Tests both V1 and V2 APIs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// Point the plugin's mode-flag at a temp config home BEFORE it loads — the
// plugin resolves its state path once at load (as it does under a real OpenCode
// process, where XDG_CONFIG_HOME is already set). The dynamic import below runs
// after this assignment, so the ordering holds.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ponytail-opencode-'));
process.env.XDG_CONFIG_HOME = tmp;
delete process.env.PONYTAIL_DEFAULT_MODE;
const statePath = path.join(tmp, 'opencode', '.ponytail-active');

let pluginV2, pluginV1, parseCommandFile;
test.before(async () => {
  const url = pathToFileURL(path.join(__dirname, '..', '.opencode', 'plugins', 'ponytail.mjs'));
  const mod = await import(url);
  pluginV2 = mod.default; // V2 plugin definition with id and setup()
  pluginV1 = mod.pluginV1; // V1 fallback function
  // The frontmatter parser used to be exported from the plugin module itself.
  // OpenCode's legacy loader treats every exported function as a plugin and
  // tried to invoke it with the plugin context object, which crashed. The
  // parser now lives in its own .cjs sibling; require it directly.
  parseCommandFile = require(path.join(__dirname, '..', '.opencode', 'plugins', 'ponytail-frontmatter.cjs')).parseCommandFile;
});

// Helper to load hooks from the plugin, supporting both V1 and V2 APIs.
async function loadHooksV1(clientOptions = {}) {
  return pluginV1(clientOptions);
}

async function loadHooksV2(clientOptions = {}) {
  // V2 setup() may receive context with nested client, or the client directly
  const context = clientOptions.client ? clientOptions : { client: clientOptions.client };
  return pluginV2.setup(context);
}

function transform(hooks) {
  const output = { system: [] };
  return hooks['experimental.chat.system.transform']({ model: {} }, output).then(() => output.system);
}

async function configure(hooks, config) {
  await hooks.config(config);
  return config;
}

// Test suite runner: runs the same tests for both V1 and V2 APIs.
function createTestSuite(apiName, loadHooks) {
  test(`[${apiName}] system.transform injects the ruleset at the default mode (full)`, async () => {
    try { fs.unlinkSync(statePath); } catch (e) {}
    const hooks = await loadHooks({});
    const system = await transform(hooks);
    assert.equal(system.length, 1);
    assert.match(system[0], /PONYTAIL MODE ACTIVE — level: full/);
    assert.match(system[0], /lazy senior developer/);
  });

  test(`[${apiName}] command.execute.before persists /ponytail ultra, transform follows it`, async () => {
    const hooks = await loadHooks({});
    await hooks['command.execute.before']({ command: 'ponytail', arguments: 'ultra', sessionID: 's' });
    assert.equal(fs.readFileSync(statePath, 'utf8'), 'ultra');
    const system = await transform(hooks);
    assert.match(system[0], /PONYTAIL MODE ACTIVE — level: ultra/);
  });

  test(`[${apiName}] /ponytail off persists off and transform injects nothing`, async () => {
    const hooks = await loadHooks({});
    await hooks['command.execute.before']({ command: 'ponytail', arguments: 'off', sessionID: 's' });
    assert.equal(fs.readFileSync(statePath, 'utf8'), 'off');
    const system = await transform(hooks);
    assert.deepEqual(system, []);
  });

  test(`[${apiName}] system.transform merges into existing system entry (Qwen compat, #296)`, async () => {
    try { fs.unlinkSync(statePath); } catch (e) {}
    const hooks = await loadHooks({});
    const output = { system: ['You are a helpful assistant.'] };
    await hooks['experimental.chat.system.transform']({ model: {} }, output);
    assert.equal(output.system.length, 1, 'must not add a second system entry');
    assert.match(output.system[0], /You are a helpful assistant/);
    assert.match(output.system[0], /PONYTAIL MODE ACTIVE/);
  });

  test(`[${apiName}] config injects the active ruleset into subagent prompts`, async () => {
    fs.writeFileSync(statePath, 'lite');
    const hooks = await loadHooks({});
    const config = await configure(hooks, {
      agent: {
        explore: { mode: 'subagent', prompt: 'Explore only.' },
        build: { mode: 'primary', prompt: 'Build the change.' },
        helper: { mode: 'all' },
      },
    });

    assert.match(config.agent.explore.prompt, /Explore only\./);
    assert.match(config.agent.explore.prompt, /PONYTAIL MODE ACTIVE — level: lite/);
    assert.equal(config.agent.build.prompt, 'Build the change.');
    assert.match(config.agent.helper.prompt, /PONYTAIL MODE ACTIVE — level: lite/);
  });

  test(`[${apiName}] config leaves subagent prompts unchanged when Ponytail is off`, async () => {
    fs.writeFileSync(statePath, 'off');
    const hooks = await loadHooks({});
    const config = await configure(hooks, {
      agent: { explore: { mode: 'subagent', prompt: 'Explore only.' } },
    });
    assert.equal(config.agent.explore.prompt, 'Explore only.');
  });

  test(`[${apiName}] unsupported /ponytail arguments do not reset the current mode`, async () => {
    const hooks = await loadHooks({});
    fs.writeFileSync(statePath, 'ultra');
    await hooks['command.execute.before']({ command: 'ponytail', arguments: 'status', sessionID: 's' });
    assert.equal(fs.readFileSync(statePath, 'utf8'), 'ultra');
  });

  test(`[${apiName}] unrelated commands do not touch the flag`, async () => {
    try { fs.unlinkSync(statePath); } catch (e) {}
    const hooks = await loadHooks({});
    await hooks['command.execute.before']({ command: 'commit', arguments: 'x', sessionID: 's' });
    assert.equal(fs.existsSync(statePath), false);
  });
}

// Run tests for both V1 and V2 APIs.
createTestSuite('V1', loadHooksV1);
createTestSuite('V2', loadHooksV2);

test('parseCommandFile reads frontmatter description + body, LF and CRLF', () => {
  const lf = path.join(tmp, 'cmd-lf.md');
  fs.writeFileSync(lf, '---\ndescription: do a thing\n---\n\nthe template body\n');
  assert.deepEqual(parseCommandFile(lf), { description: 'do a thing', template: 'the template body' });

  // Windows checkouts (autocrlf) deliver CRLF — the parser must still match.
  const crlf = path.join(tmp, 'cmd-crlf.md');
  fs.writeFileSync(crlf, '---\r\ndescription: do a thing\r\n---\r\n\r\nthe template body\r\n');
  assert.deepEqual(parseCommandFile(crlf), { description: 'do a thing', template: 'the template body' });
});

test('parseCommandFile returns null when there is no frontmatter', () => {
  const bare = path.join(tmp, 'cmd-bare.md');
  fs.writeFileSync(bare, 'no frontmatter here\n');
  assert.equal(parseCommandFile(bare), null);
});

// V2 plugin shape tests.
test('[V2] plugin has correct V2 shape (id and setup)', () => {
  assert.equal(pluginV2.id, 'ponytail', 'plugin must have id');
  assert.equal(typeof pluginV2.setup, 'function', 'plugin must have setup function');
});

// V1 fallback tests.
test('[V1] plugin fallback is callable as V1 function', () => {
  assert.equal(typeof pluginV1, 'function', 'pluginV1 must be a function');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

