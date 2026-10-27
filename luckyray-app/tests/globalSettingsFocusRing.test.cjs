const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const app=path.resolve(__dirname,'..'),req=createRequire(app+'/package.json'),postcss=createRequire(req.resolve('vite'))('postcss');
const css=fs.readFileSync(app+'/src/features/settings/settingsGlobalPolish.css','utf8'),root=postcss.parse(css);
test('settings native select uses one contiguous accent focus stroke without an extra shadow',()=>{
 const selector='.luckyray-settings-page .settings-panel:not(.settings-appearance-panel) select:focus-visible';
 const rule=root.nodes.find(node=>node.type==='rule'&&node.selector===selector);assert.ok(rule);
 const values=Object.fromEntries(rule.nodes.filter(node=>node.type==='decl').map(node=>[node.prop,node.value]));
 assert.equal(values['border-color'],'var(--accent)');assert.equal(values.outline,'2px solid var(--accent)');
 assert.equal(values['outline-offset'],'-1px');assert.equal(values['box-shadow'],'none');
 const general=root.nodes.find(node=>node.type==='rule'&&node.selector.includes(':is(button, select, input, summary, [tabindex="0"]):focus-visible'));
 assert.ok(general);assert.ok(root.nodes.indexOf(rule)>root.nodes.indexOf(general));
 assert.equal(rule.nodes.some(node=>node.type==='decl'&&['display','padding','margin','width','height'].includes(node.prop)),false);
});
test('other settings keyboard focus and approved appearance styles retain their existing focus indicator',()=>{
 const general=root.nodes.find(node=>node.type==='rule'&&node.selector.includes('.settings-confirm button:focus-visible'));
 assert.ok(general.nodes.some(node=>node.prop==='outline'&&node.value==='2px solid var(--text-secondary)'));
 assert.ok(general.nodes.some(node=>node.prop==='outline-offset'&&node.value==='3px'));
 assert.ok(!root.nodes.some(node=>node.type==='rule'&&node.selector.includes('select:focus-visible')&&node.nodes.some(decl=>decl.prop==='outline'&&decl.value==='none')));
});
