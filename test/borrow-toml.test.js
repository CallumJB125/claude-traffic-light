// Synthetic-only repair boundaries. No HOME scan, commands, credentials or
// network. Equivalent TOML spellings must not change secret-container policy.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { scrubFile } = require('../src/borrow/scrub.js');
const secret = ['quiet', 123, 'river', 456].join('');
const path = '~/.codex/config.toml';
function safe(content, options = {}, needles = [secret]) {
  const result = scrubFile({path,content,...options});
  for (const value of needles) assert.equal(JSON.stringify(result).includes(value), false, 'original value survived in output or metadata');
  if (result.status === 'blocked') {
    assert.equal(Object.hasOwn(result,'content'),false);
    assert.deepEqual(result.redactions,[]); assert.deepEqual(result.templates,[]);
  }
  return result;
}
function ok(content, options = {}) { const result=safe(content,options); assert.equal(result.status,'ok',result.reason); return result; }
test('TOML quoted inline env/header names are equivalent to bare names',()=>{
  for(const name of ['env','headers','http_headers','environment']) for(const key of [name,JSON.stringify(name),"'"+name+"'"]) {
    ok(key+' = { NEUTRAL = "'+secret+'" }\n');
    ok('mcp_servers.fixture.'+key+' = { NEUTRAL = "'+secret+'" }\n');
    ok('mcp_servers = { fixture = { '+key+' = { NEUTRAL = "'+secret+'" } } }\n');
  }
});
test('TOML escaped and quoted nested table names retain secret policy',()=>{
  for(const table of ['["e\\u006ev"]','["e\\U0000006ev"]','[mcp_servers."fixture.with.dots"."e\\u006ev"]',"[mcp_servers.'fixture with spaces'.'headers']",'["http_\\u0068eaders"]','["mcp_servers.fixture.env"]']) {
    ok(table+'\nNEUTRAL = "'+secret+'"\n');
  }
});
test('TOML dotted keys, arrays and nested inline values inherit the secret container',()=>{
  for(const content of [
    '"e\\u006ev".NEUTRAL = "'+secret+'"\n',
    'mcp_servers."fixture"."headers".NEUTRAL = "'+secret+'"\n',
    'env = { NEUTRAL = ["'+secret+'", { nested = "'+secret+'" }] }\n',
    'env = {\n NEUTRAL = { deeper = "'+secret+'" },\n}\n',
    '[[mcp_servers.fixture.env]]\nNEUTRAL = "'+secret+'"\n',
  ]) ok(content);
});
test('TOML ordinary/triple basic/literal bodies redact exact full ranges',()=>{
  for(const quote of ['"',"'",'"""',"'''"]) for(const nl of ['\n','\r\n']) {
    const multiline=quote.length===3;
    const content='[env]'+nl+'NEUTRAL = '+quote+(multiline?nl:'')+secret+(multiline?nl:'')+quote+nl+'OTHER = "$OPENAI_API_KEY"'+nl;
    const result=ok(content); assert.ok(result.content.includes('$OPENAI_API_KEY')); assert.ok(result.content.includes(quote));
  }
  ok('[env]\nNEUTRAL = "quiet\\u003123river456"\n');
  ok('[env]\nNEUTRAL = """\nquiet\\\n   123river456\n"""\n');
});
test('TOML multiline body text cannot create a public table or terminate an inline container',()=>{
  for(const quote of ['"""',"'''"]) {
    ok('env = { NEUTRAL = '+quote+'\n[public]\n'+secret+'\n} # fake boundary\n'+quote+', OTHER = "$REFERENCE" }\n');
  }
  ok('"env" = { NEUTRAL = "public } [public] '+secret+'", OTHER = "$REFERENCE" }\n');
});
test('TOML key and table provenance compares decoded material with redacted values',()=>{
  const encoded='quiet\\u003123river456';
  for(const content of [
    '["e\\u006ev"]\n"copy_'+secret+'" = "'+secret+'"\n',
    '[env]\n"copy_'+encoded+'" = "'+secret+'"\n',
    '[env."copy_'+secret+'"]\nNEUTRAL = "'+secret+'"\n',
    'env = { "copy_'+secret+'" = """\n'+secret+'\n""" }\n',
  ]) assert.equal(safe(content).status,'blocked');
});
test('decoded secret quotes and spaces are value bytes during key provenance checks',()=>{
  for(const value of ['"abcdefg',"'abcdefg",' abcdefg']) {
    const toml='[env]\n'+JSON.stringify('copy_'+value)+' = '+JSON.stringify(value)+'\n';
    assert.equal(scrubFile({path,content:toml}).status,'blocked');
    const json=JSON.stringify({env:{['copy_'+value]:value}});
    assert.equal(scrubFile({path:'~/.config/fixture.json',content:json}).status,'blocked');
  }
});
test('TOML unknown or ambiguous string/container syntax is refused without original bytes',()=>{
  for(const content of [
    '[env]\nNEUTRAL = "unterminated '+secret+'\n',
    '[env]\nNEUTRAL = "\\x41'+secret+'"\n',
    '[env]\nNEUTRAL = "\\uD800'+secret+'"\n',
    '[env]\nNEUTRAL = "\\U00110000'+secret+'"\n',
    '[env]\nNEUTRAL = """\n'+secret+'\n',
    '["""env"""]\nNEUTRAL = "'+secret+'"\n',
    'env = { NEUTRAL = "'+secret+'"\n',
    'env = { NEUTRAL = "'+secret+'" OTHER = "public" }\n',
    'env = { NEUTRAL = '+secret+' }\n',
    '[env] extra\nNEUTRAL = "'+secret+'"\n',
  ]) { const result=safe(content); assert.equal(result.status,'blocked'); assert.match(result.reason,/TOML structure/); }
});
test('TOML nesting and key/value budgets fail closed with fixed bounded reasons',()=>{
  const nested='env = '+ '{ inner = '.repeat(34)+'"'+secret+'"'+' }'.repeat(34)+'\n';
  assert.match(safe(nested).reason,/safe review budget/);
  const many=Array.from({length:32769},(_,i)=>'k'+i+' = 0\n').join('');
  const result=safe(many); assert.equal(result.status,'blocked'); assert.match(result.reason,/too many structured keys or values/);
});
test('TOML key-path budgets prevent repeated large table-prefix work',()=>{
  for(const content of [
    '['+'part.'.repeat(33)+'env]\nNEUTRAL = "'+secret+'"\n',
    '['+JSON.stringify('public'.repeat(1000))+']\nNEUTRAL = "'+secret+'"\n',
    '[env]\n'+JSON.stringify('public'.repeat(1000))+' = "'+secret+'"\n',
  ]) { const result=safe(content); assert.equal(result.status,'blocked'); assert.match(result.reason,/safe review budget/); }
  const content='['+JSON.stringify('public'.repeat(650))+']\n'+Array.from({length:8000},(_,i)=>'k'+i+' = "public"\n').join('');
  const start=performance.now(); ok(content); assert.ok(performance.now()-start<2000);
});
test('TOML benign strings, tables, braces, comments, dates and git pins remain literal',()=>{
  const pin=['1234567890abcdef','1234567890abcdef','12345678'].join('');
  const content='["fixture.with.dots"] # public\n"public key" = "brace } and [env]"\n' +
    "literal = '''\npublic text\n'''\n"+'basic = """\npublic \\u0020 text\n"""\n'+
    'rev = "'+pin+'"\nempty = ""\nwhen = 2026-10-01T12:00:00Z\nvalues = [1, true, { public = "theme" }]\n';
  assert.equal(ok(content).content,content);
});
test('TOML actual references and booleans survive known containers without exempting adjoining text',()=>{
  const content='"env" = { REF = "$OPENAI_API_KEY", REF2 = "${NPM_TOKEN}", FLAG = "true", SWITCH = false }\n';
  assert.equal(ok(content).content,content);
  ok('env = { REF = "$OPENAI_API_KEY '+secret+'" }\n');
  ok('env = { REF = "op://Fixture/item/field '+secret+'" }\n');
});
test('TOML extra registry secret tables share quoted/escaped scope handling',()=>{
  for(const name of ['custom_env','"custom_\\u0065nv"',"'custom_env'"]) ok(name+' = { NEUTRAL = "'+secret+'" }\n',{sensitiveKeys:['custom_env']});
});
test('decoded TOML stand-ins preserve original-input placeholder refusal',()=>{
  for(const content of [
    'note = "\\u007b\\u007bSECRET:neutral\\u007d\\u007d"\n',
    '"\\u007b\\u007bHOME\\u007d\\u007d" = "public"\n',
    'env = { NEUTRAL = "\\u007b\\u007bGH:neutral\\u007d\\u007d" }\n',
  ]) { const result=safe(content); assert.equal(result.status,'blocked'); assert.match(result.reason,/placeholder syntax/); }
});
test('TOML short values under neutral public keys remain a human-review concern',()=>{
  const content='public_note = "plain words"\n'; assert.equal(ok(content).content,content);
});
test('URL query names and percent spellings participate in duplicated-key provenance',()=>{
  for(const query of [secret,encodeURIComponent(secret),secret.replace('1','%31')]) {
    const content=JSON.stringify({env:{['copy_'+secret]:'https://public.example/?'+query+'=public'}});
    assert.equal(safe(content,{path:'~/.config/fixture.json'}).status,'blocked');
  }
  const content=JSON.stringify({env:{'public.example':'https://public.example/?public=fixture'}});
  assert.equal(safe(content,{path:'~/.config/fixture.json'}).status,'ok');
});
test('bounded TOML reader stays fast on a 1 MiB quoted body',()=>{
  const body='public '.repeat(149780); const content='note = """'+body+'"""\n';
  const start=performance.now(); const result=ok(content); assert.ok(performance.now()-start<2000); assert.equal(result.content,content);
});
