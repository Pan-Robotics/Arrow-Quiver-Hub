globalThis.self = { addEventListener: () => {}, postMessage: () => {} };

const { default: DataflashParser } = await import('/home/ubuntu/rplidar_web_server/client/src/lib/dataflash-parser.js');
import fs from 'fs';

const file = fs.readFileSync('/home/ubuntu/upload/00000072.log');
const arrayBuffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);

const parser = new DataflashParser(false);
const allMsgs = ['CMD','MSG','FILE','MODE','AHR2','ATT','GPS','POS','PARM','STAT','EV',
                 'RATE','BARO','ESC','BAT','GPA','VIBE','RCIN','RCOU','XKF4'];
const result = parser.processData(arrayBuffer, allMsgs);

console.log('=== extractStartTime ===');
try {
  const startTime = parser.extractStartTime();
  console.log('Start time:', startTime);
  if (startTime) {
    console.log('Start time ISO:', startTime.toISOString());
  } else {
    console.log('No start time returned (undefined)');
  }
} catch (e) {
  console.log('extractStartTime error:', e.message);
  console.log(e.stack);
}

console.log('\n=== stats ===');
try {
  const stats = parser.stats();
  const topStats = Object.entries(stats)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);
  for (const [name, s] of topStats) {
    console.log(`  ${name}: ${s.count} messages`);
  }
} catch (e) {
  console.log('stats error:', e.message);
  console.log(e.stack);
}

console.log('\n=== Message keys check ===');
const msgKeys = Object.keys(result.messages).sort();
console.log(`Total message keys: ${msgKeys.length}`);
for (const k of msgKeys) {
  const d = result.messages[k];
  const len = d.time_boot_ms ? d.time_boot_ms.length : 'no time';
  console.log(`  ${k}: ${len} records`);
}
