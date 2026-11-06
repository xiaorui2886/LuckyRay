import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { projectAiSettingsForFrontend } from "../src/core/services/aiSettingsPrivacy.ts";
test("native configured flags survive null placeholders without exposing any secret", () => {
 const p=projectAiSettingsForFrontend({aiApiKey:null,aiImageApiKey:null,aiApiKeyConfigured:true,aiImageApiKeyConfigured:true});
 assert.equal(projectAiSettingsForFrontend({aiApiKey:"synthetic-key",unrelatedPreference:"kept"}).unrelatedPreference,"kept");
 assert.equal(p.aiApiKeyConfigured,true);assert.equal(p.aiImageApiKeyConfigured,true);assert.equal(p.aiApiKey,null);
 assert.equal(projectAiSettingsForFrontend({...p,aiApiKey:""}).aiApiKeyConfigured,false);
 assert.equal(projectAiSettingsForFrontend({...p,aiApiKey:"synthetic-key"}).aiApiKey,null);
});
test("generic settings SQL carries metadata only and browser imports cannot overwrite native rows", () => {
 const src=readFileSync(new URL("../src/App.tsx",import.meta.url),"utf8");
 const settings=src.slice(src.indexOf("async function getStoredSettings"),src.indexOf("// ===== AI CONVERSATION BRIDGE"));
 assert(!settings.includes("[\"aiApiKey\",")); assert(!settings.includes("[\"aiImageApiKey\","));
 assert(!settings.includes("'aiApiKey'"));assert(!settings.includes("'aiImageApiKey'"));
 assert(settings.includes('"ai_settings_secret_status"'));assert(settings.includes('apiKey: patch.aiApiKey ?? null'));
 assert(src.includes("onlyIfMissing: true"));
 assert(src.indexOf("JSON.stringify(projectAiSettingsForFrontend(legacySettings))")>src.indexOf("onlyIfMissing: true"));
});
