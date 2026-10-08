// The cloud runner's systemd kit (board/deploy/pi): the sandboxing the
// runbook promises stays in the unit, and no secret sits in the env template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'pi');
const unit = fs.readFileSync(path.join(PI, 'buddy-runner.service'), 'utf8');
const directives = (name) => unit.split('\n').filter((l) => l.startsWith(`${name}=`)).map((l) => l.slice(name.length + 1));
const one = (name) => { const v = directives(name); assert.equal(v.length, 1, `${name} once`); return v[0]; };

test('buddy-runner.service: a dedicated unprivileged user, read-only system, only its own state writable', () => {
  assert.equal(one('User'), 'buddyrunner');
  assert.equal(one('NoNewPrivileges'), 'yes');
  assert.equal(one('ProtectSystem'), 'strict');
  assert.equal(one('ProtectHome'), 'yes');
  assert.equal(one('ReadWritePaths'), '/var/lib/buddy-runner');
  const hidden = one('InaccessiblePaths').split(/\s+/).map((p) => p.replace(/^-/, ''));
  for (const p of ['/var/lib/buddy-hub', '/var/lib/buddy-hub-staging', '/etc/buddy-hub']) assert.ok(hidden.includes(p), `${p} hidden`);
  assert.match(one('LoadCredential'), /^runner-token:\/etc\/buddy-runner\/runner\.token$/);
  assert.equal(one('ExecStart'), '/usr/bin/node runner/cli.js hosted');
});

test('buddy-runner.service: resource limits and per-run cgroup delegation; namespaces stay available to the CLI sandboxes', () => {
  assert.match(one('MemoryMax'), /^\d+G$/);
  assert.match(one('CPUQuota'), /^\d+%$/);
  assert.match(one('TasksMax'), /^\d+$/);
  assert.equal(one('Delegate'), 'yes');
  assert.equal(one('DelegateSubgroup'), 'supervisor', 'runner/hosted/cgroup.js expects its process in the supervisor leaf');
  assert.equal(directives('RestrictNamespaces').length, 0, 'bubblewrap / Codex sandboxes need user, mount and net namespaces');
  assert.equal(directives('ProtectControlGroups').length, 0, 'the delegated subtree must stay writable');
  assert.match(one('IPAddressDeny'), /192\.168\.0\.0\/16/);
  assert.match(one('IPAddressDeny'), /100\.64\.0\.0\/10/);
  assert.match(one('IPAddressAllow'), /localhost/);
});

test('runner.env.example holds placeholders only; the install script refuses hub paths and never starts with placeholders', () => {
  const env = fs.readFileSync(path.join(PI, 'runner.env.example'), 'utf8');
  assert.doesNotMatch(env, /brt_[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9-]{10,}|ghs_[A-Za-z0-9]{10,}/);
  assert.doesNotMatch(env, /^BUDDY_RUNNER_TOKEN/m, 'the token is a LoadCredential file, never an env var');
  const install = fs.readFileSync(path.join(PI, 'install-runner.sh'), 'utf8');
  assert.match(install, /refusing a hub path/);
  assert.match(install, /still has placeholders/);
  assert.doesNotMatch(install, /apt(-get)? install|npm install -g/, 'packages and AI CLIs are owner steps');
  assert.ok((fs.statSync(path.join(PI, 'install-runner.sh')).mode & 0o111) !== 0 || process.platform === 'win32');
});
