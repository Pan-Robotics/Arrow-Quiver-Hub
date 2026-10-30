import { describe, expect, it, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const suite = resolve("companion_scripts");
const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(),"quiver-preflight-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
function command(helper: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
 return spawnSync("python3",[join(suite,helper),...args],{encoding:"utf8",env,timeout:15000});
}
describe("Companion installer preflight", () => {
 it.each(["relative", "/tmp/new\nExecStartPre=bad", '/tmp/quoted"name', "/tmp/$variable", "/etc/../", "/tmp/pattern*"])("rejects unsafe path %s", value => {
   expect(command("installer_support.py",["path",value]).status).not.toBe(0);
 });
 it("rejects copy symlinks and preserves their referent", () => {
   const root=temp(), source=join(root,"source.py"), target=join(root,"target.py"), outside=join(root,"outside.txt");
   writeFileSync(source,"trusted source"); writeFileSync(outside,"untouched"); symlinkSync(outside,target);
   const result=command("installer_support.py",["copy",source,target]);
   expect(result.status).not.toBe(0); expect(readFileSync(outside,"utf8")).toBe("untouched");
 });
 it("fails on ignored directives before installing any proposed unit", () => {
   const root=temp(), stage=join(root,"stage"), units=join(root,"units"); mkdirSync(stage); mkdirSync(units);
   writeFileSync(join(stage,"quiver-hub-client.service"),'[Service]\nWorkingDirectory=/tmp\nEnvironmentFile="/tmp/ignored"\nExecStart=/usr/bin/true\n');
   const result=command("installer_support.py",["install-units",stage,units],{...process.env,SYSTEMD_UNIT_PATH:`${units}:/usr/lib/systemd/system:/lib/systemd/system`});
   expect(result.status).not.toBe(0); expect(result.stderr).toContain("path is not absolute"); expect(existsSync(join(units,"quiver-hub-client.service"))).toBe(false);
 });
 it("rejects a bad installed drop-in before replacement and preserves the previous base unit", () => {
   const root=temp(), stage=join(root,"stage"), units=join(root,"units"); mkdirSync(stage); mkdirSync(units);
   const name="quiver-hub-client.service", before='[Service]\nExecStart=/usr/bin/true\n';
   writeFileSync(join(units,name),before); writeFileSync(join(stage,name),'[Service]\nWorkingDirectory=/tmp\nExecStart=/usr/bin/true\n');
   mkdirSync(join(units,name+".d")); writeFileSync(join(units,name+".d","override.conf"),'[Service]\nWorkingDirectory=relative/bad\n');
   const result=command("installer_support.py",["install-units",stage,units],{...process.env,SYSTEMD_UNIT_PATH:`${units}:/usr/lib/systemd/system:/lib/systemd/system`});
   expect(result.status).not.toBe(0); expect(readFileSync(join(units,name),"utf8")).toBe(before);
 });
 it("migrates a blank canonical Hub alias to a valid legacy alias and rejects multiline syntax clearly", () => {
   const root=temp(), config=join(root,"settings.conf");
   writeFileSync(config,"HUB_URL=\nWEB_SERVER_URL=https://legacy.invalid\n");
   expect(command("companion_config.py",["get",config,"HUB_URL"]).stdout.trim()).toBe("https://legacy.invalid");
   expect(command("companion_config.py",["init",config]).status).toBe(0);
   expect(readFileSync(config,"utf8")).toContain('HUB_URL="https://legacy.invalid"');
   writeFileSync(config,'HUB_URL="unterminated\nsecond line"\n');
   const result=command("companion_config.py",["get",config,"HUB_URL"]);
   expect(result.status).not.toBe(0); expect(result.stderr).toContain("Multiline/unclosed"); expect(result.stderr).not.toContain("Traceback");
 });
 it.each(["127.0.0.1","224.0.0.1","0.0.0.0"])("refuses unusable FC puller target %s", ip => {
   const root=temp(), config=join(root,"settings.conf"), output=join(root,"params.txt");
   writeFileSync(config,`COMPANION_IP=${ip}\nFIRMWARE_SERVER_PORT=8070\n`);
   expect(command("companion_config.py",["render-fc-params",config,output]).status).not.toBe(0); expect(existsSync(output)).toBe(false);
 });
 it.each(["UPDATE_RATE_HZ=nan","POLL_INTERVAL=zero","FIRMWARE_SERVER_PORT=99999","TAILSCALE_FUNNEL_PORT=22"])("rejects invalid config before installing: %s", setting => {
   const root=temp(), config=join(root,"settings.conf");
   writeFileSync(config,`HUB_URL=https://hub.invalid\nDRONE_ID=demo\nAPI_KEY=not-a-real-key\n${setting}\n`);
   const result=command("companion_config.py",["validate",config]); expect(result.status).not.toBe(0); expect(result.stderr).not.toContain("not-a-real-key"); expect(result.stderr).not.toContain("Traceback");
 });
});


describe("Companion CLI configuration errors", () => {
 it.each([
  ["camera_stream_service.py", "GO2RTC_API_PORT=not-a-port"],
  ["siyi_camera_controller.py", "SIYI_SDK_PORT=not-a-port"],
 ])("keeps %s help import-safe and rejects invalid ports before network activity", (name, setting) => {
  const root=temp(), config=join(root,"settings.conf");
  writeFileSync(config,`HUB_URL=https://hub.invalid\nDRONE_ID=demo\nAPI_KEY=not-a-real-key\n${setting}\n`);
  const env={PATH:process.env.PATH??"",QUIVER_ENV_FILE:config};
  const help=command(name,["--help"],env);
  expect(help.status,help.stderr).toBe(0);
  const invalid=command(name,[],env);
  expect(invalid.status).not.toBe(0);
  expect(invalid.stderr).not.toContain("Traceback");
  expect(invalid.stderr).not.toContain("not-a-real-key");
 });
});
