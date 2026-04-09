// Test script for DataflashParser with sample .BIN file
import fs from 'fs';

// Mock self for Web Worker context
globalThis.self = {
  addEventListener: () => {},
  postMessage: (msg) => {
    // silently consume postMessage calls
  }
};

// Read the parser, strip the export and eval it
const parserCode = fs.readFileSync('/home/ubuntu/rplidar_web_server/client/src/lib/dataflash-parser.js', 'utf8');
const cleanCode = parserCode.replace('export default DataflashParser', '');
const evalFunc = new Function('self', cleanCode + '\nreturn DataflashParser;');
const DataflashParser = evalFunc(globalThis.self);

if (!DataflashParser) {
  console.error('DataflashParser not found');
  process.exit(1);
}

console.log('DataflashParser loaded successfully');

// Read the BIN file
const buffer = fs.readFileSync('/home/ubuntu/upload/00000092.BIN');
const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

console.log(`File size: ${arrayBuffer.byteLength} bytes`);

// Check first few bytes for HEAD1/HEAD2 (0xA3=163, 0x95=149)
const view = new DataView(arrayBuffer);
console.log(`First bytes: 0x${view.getUint8(0).toString(16)}, 0x${view.getUint8(1).toString(16)}, 0x${view.getUint8(2).toString(16)}`);

// Create parser (false = not web worker mode, so it won't call self.postMessage)
const parser = new DataflashParser(false);

// Process the data - pass the ArrayBuffer and specify which message types to parse
// processData(data, msgs) - msgs is the list of message types to parse at offset
// The default msgs list is: CMD, MSG, FILE, MODE, AHR2, ATT, GPS, POS, XKQ1, XKQ, NKQ1, NKQ2, XKQ2, PARM, MSG, STAT, EV
// We also want: RATE, BARO, ESC, BAT, GPA, VIBE, RCIN, RCOU, XKF4
const allMsgs = [
  'CMD', 'MSG', 'FILE', 'MODE', 'AHR2', 'ATT', 'GPS', 'POS',
  'XKQ1', 'XKQ', 'NKQ1', 'NKQ2', 'XKQ2', 'PARM', 'STAT', 'EV',
  'RATE', 'BARO', 'ESC', 'BAT', 'GPA', 'VIBE', 'RCIN', 'RCOU', 'XKF4'
];

console.log('\nParsing...');
const result = parser.processData(arrayBuffer, allMsgs);

console.log('\n=== Message Types Found ===');
const typeNames = Object.keys(result.types);
console.log(`Total message types: ${typeNames.length}`);
console.log('Types:', typeNames.sort().join(', '));

console.log('\n=== Chart-relevant Message Types ===');
const chartTypes = ['ATT', 'RATE', 'BARO', 'ESC', 'BAT', 'GPA', 'VIBE', 'RCIN', 'RCOU', 'XKF4'];
for (const ct of chartTypes) {
  const found = typeNames.includes(ct);
  // Also check for instance variants like ESC[0], BAT[0]
  const instances = typeNames.filter(t => t.startsWith(ct + '['));
  if (found) {
    const fields = result.types[ct].expressions;
    console.log(`  ✓ ${ct}: ${fields.join(', ')}`);
  } else if (instances.length > 0) {
    const fields = result.types[instances[0]].expressions;
    console.log(`  ✓ ${ct} (instances: ${instances.join(', ')}): ${fields.join(', ')}`);
  } else {
    console.log(`  ✗ ${ct}: NOT FOUND`);
  }
}

console.log('\n=== Parsed Messages ===');
const msgNames = Object.keys(result.messages);
console.log(`Total parsed messages: ${msgNames.length}`);
for (const name of msgNames.sort()) {
  const msg = result.messages[name];
  const fields = Object.keys(msg);
  const sampleField = fields[0];
  const count = msg[sampleField] ? (msg[sampleField].length || 'N/A') : 'empty';
  console.log(`  ${name}: ${count} records, fields: ${fields.join(', ')}`);
}

// Show sample data for ATT if available
if (result.messages.ATT) {
  console.log('\n=== Sample ATT Data (first 5 records) ===');
  const att = result.messages.ATT;
  const fields = Object.keys(att);
  for (let i = 0; i < Math.min(5, att[fields[0]].length); i++) {
    const row = {};
    for (const f of fields) {
      row[f] = typeof att[f][i] === 'number' ? att[f][i].toFixed(4) : att[f][i];
    }
    console.log(`  [${i}]`, row);
  }
}

// Check stats
console.log('\n=== Log Stats (top 15 by count) ===');
const stats = parser.stats();
for (const [name, info] of Object.entries(stats).sort((a, b) => b[1].count - a[1].count).slice(0, 15)) {
  console.log(`  ${name}: ${info.count} messages, ${info.msg_size} bytes/msg, ${(info.size / 1024).toFixed(1)} KB total`);
}

console.log('\n=== Parser Test PASSED ===');
