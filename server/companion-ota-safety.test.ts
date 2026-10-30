import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const suite = resolve("companion_scripts");
function python(body: string) {
 const root=mkdtempSync(join(tmpdir(),"quiver-ota-safety-")), config=join(root,"settings.conf");
 writeFileSync(config,"FC_IP=10.20.0.51\nFIRMWARE_SERVER_PORT=8070\n");
 try {
  const result=spawnSync("python3",["-c",`import sys, asyncio, types, pathlib, hashlib, time\nsys.path.insert(0,${JSON.stringify(suite)})\nimport logs_ota_service as ota\n${body}`],{encoding:"utf8",timeout:15000,env:{PATH:process.env.PATH??"",QUIVER_ENV_FILE:config,TEST_ROOT:root}});
  expect(result.status,result.stdout+result.stderr).toBe(0);
 } finally {rmSync(root,{recursive:true,force:true});}
}
describe("Fail-closed companion OTA safety",()=>{
 it("allows only an explicit fresh boolean DISARMED sample and refuses absent/unknown/timeout telemetry",()=>python(`
async def run():
 hub=types.SimpleNamespace(report_firmware_progress=lambda *a,**k:None)
 for sample in (False,True,None,0,"false"):
  async def armed(): yield sample
  ftp=types.SimpleNamespace(connected=True,system=types.SimpleNamespace(telemetry=types.SimpleNamespace(armed=armed)))
  handler=ota.LogsOtaJobHandler(hub,ftp); handler.ARM_STATE_TIMEOUT=0.02
  safe,_=await handler._require_fresh_disarmed('test')
  assert safe is (sample is False),repr(sample)
  syncer=ota.FCLogSyncer(log_store_dir='/tmp',mavsdk_system=ftp.system); syncer.ARM_STATE_TIMEOUT=0.02
  assert await syncer._check_arm_state() is (sample is False)
 async def stalled():
  await asyncio.sleep(1)
  yield False
 handler.ftp.system.telemetry.armed=stalled
 assert (await handler._require_fresh_disarmed('test'))[0] is False
 handler.ftp.connected=False
 assert (await handler._require_fresh_disarmed('test'))[0] is False
asyncio.run(run())
`));
 it("never accepts buffered bytes as transfer completion and requires a valid hash before any download",()=>python(`
async def run():
 hub=types.SimpleNamespace(report_firmware_progress=lambda *a,**k:None)
 handler=ota.LogsOtaJobHandler(hub,types.SimpleNamespace(connected=False,system=None))
 handler._fw_serve_size=handler._fw_serve_bytes_sent=4096
 async def no_sleep(*a): pass
 old=ota.asyncio.sleep; ota.asyncio.sleep=no_sleep
 try: assert await handler._wait_for_fc_pull(1,timeout=2) is False
 finally: ota.asyncio.sleep=old
 ota.requests=types.SimpleNamespace(get=lambda *a,**k:(_ for _ in ()).throw(AssertionError('network must not be used')))
 for digest in (None,'bad','f'*63):
  ok,error=await handler.handle_flash_firmware({'payload':{'updateId':1,'firmwareUrl':'https://firmware.invalid/file','sha256Hash':digest}})
  assert ok is False and 'SHA-256' in error
asyncio.run(run())
`));
 it("rejects wrong peers and premature ACK without starting any actual listener",()=>python(`
import os
routes={}
class HTTPError(Exception):
 def __init__(self,*a,**k): pass
class App:
 def __init__(self): self.router=types.SimpleNamespace(add_get=lambda path,fn:routes.__setitem__(path,fn))
class Runner:
 def __init__(self,app): pass
 async def setup(self): pass
 async def cleanup(self): pass
class Site:
 def __init__(self,*a,**k): pass
 async def start(self): pass
fake=types.SimpleNamespace(Application=App,AppRunner=Runner,TCPSite=Site,HTTPForbidden=HTTPError,HTTPConflict=HTTPError,Response=lambda **k:k,json_response=lambda value:value)
ota.aiohttp_web=fake
async def run():
 path=pathlib.Path(os.environ['TEST_ROOT'])/'firmware.bin'; path.write_bytes(b'12345678')
 handler=ota.LogsOtaJobHandler(types.SimpleNamespace(report_firmware_progress=lambda *a,**k:None),types.SimpleNamespace(connected=False,system=None))
 assert await handler._start_firmware_server(str(path))
 wrong=types.SimpleNamespace(remote='10.20.0.100'); right=types.SimpleNamespace(remote='10.20.0.51')
 for route in routes.values():
  try: await route(wrong)
  except HTTPError: pass
  else: raise AssertionError('wrong peer accepted')
 try: await routes['/firmware/ack'](right)
 except HTTPError: pass
 else: raise AssertionError('premature ACK accepted')
 response=await routes['/firmware/download'](right); assert len(response['body'])==8
 assert await routes['/firmware/ack'](right)=={'status':'ok'}
 assert handler._fw_serve_downloaded is True
asyncio.run(run())
`));
 it("rechecks arming immediately before exposure and reboot and never reboots an unsafe FC",()=>python(`
samples=[]; reboot_calls=[]; exposure=[]
data=b'git version: abc123\\nMD5: testing\\n--\\nfirmware'
class Response:
 content=data
 def raise_for_status(self): pass
 def close(self): pass
async def armed(): yield samples.pop(0)
async def reboot(): reboot_calls.append(True); raise RuntimeError('test reboot refused')
ota.requests=types.SimpleNamespace(get=lambda *a,**k:Response()); ota.aiohttp_web=object()
async def run():
 hub=types.SimpleNamespace(report_firmware_progress=lambda *a,**k:None)
 ftp=types.SimpleNamespace(connected=True,system=types.SimpleNamespace(telemetry=types.SimpleNamespace(armed=armed),action=types.SimpleNamespace(reboot=reboot)))
 job={'payload':{'updateId':1,'firmwareUrl':'https://firmware.invalid/f.bin','filename':'firmware.abin','sha256Hash':hashlib.sha256(data).hexdigest()}}
 for sequence,expected_exposure in (([True],0),([False,True],1),([False,None],1),([False,False],1)):
  samples[:]=sequence; reboot_calls.clear(); exposure.clear()
  handler=ota.LogsOtaJobHandler(hub,ftp)
  handler._http_fc_reachable=lambda:False
  async def start(*a): exposure.append(True); return True
  async def stop(): pass
  async def pulled(*a): return True
  handler._start_firmware_server=start; handler._stop_firmware_server=stop; handler._wait_for_fc_pull=pulled
  ok,error=await handler.handle_flash_firmware(job)
  assert ok is False,(sequence,error)
  assert len(exposure)==expected_exposure
  assert len(reboot_calls)==(1 if sequence==[False,False] else 0)
asyncio.run(run())
`));
 it("keeps an async heartbeat responsive during blocking log HTTP and checks again at each 4MiB boundary",()=>python(`
import os
root=pathlib.Path(os.environ['TEST_ROOT']); checks=[]
async def armed():
 checks.append(1); yield len(checks)==1 and False or True
# Explicit generator avoids boolean-expression ambiguity.
async def samples():
 checks.append(1)
 yield False if len(checks)==1 else True
class Response:
 def raise_for_status(self): pass
 def close(self): pass
 def iter_content(self,**kw):
  time.sleep(0.05)
  yield b'x'*(4*1024*1024+1)
ota.requests=types.SimpleNamespace(get=lambda *a,**k:Response())
async def run():
 syncer=ota.FCLogSyncer(log_store_dir=str(root),mavsdk_system=types.SimpleNamespace(telemetry=types.SimpleNamespace(armed=samples)))
 syncer._save_manifest=lambda:None; syncer._record_attempt=lambda *a:None
 ticks=[]
 async def ticker():
  for i in range(10): ticks.append(i); await asyncio.sleep(0.01)
 ok,_=await asyncio.gather(syncer._download_log_file({'name':'00000001.BIN','href':'00000001.BIN'}),ticker())
 assert ok is False and len(checks)>=2
 assert len(ticks)==10
 assert not (root/'00000001.BIN').exists()
 assert ota._safe_fc_log_filename('../../escape.BIN') is None
asyncio.run(run())
`));
});
