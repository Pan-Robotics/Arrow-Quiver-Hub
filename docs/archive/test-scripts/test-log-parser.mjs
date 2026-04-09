// Test script for DataflashParser with sample .log file (text format)
import fs from 'fs';

// Mock self for Web Worker context
globalThis.self = {
  addEventListener: () => {},
  postMessage: (msg) => {}
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

// Read the .log file as text first to check format
const textContent = fs.readFileSync('/home/ubuntu/upload/00000072.log', 'utf8');
const lines = textContent.split('\n');
console.log(`File: 00000072.log`);
console.log(`Size: ${textContent.length} bytes`);
console.log(`Lines: ${lines.length}`);
console.log(`First line: ${lines[0].substring(0, 100)}`);
console.log(`Format: ${lines[0].startsWith('FMT') ? 'TEXT LOG' : 'UNKNOWN'}`);

// Read as ArrayBuffer for the parser
const buffer = fs.readFileSync('/home/ubuntu/upload/00000072.log');
const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

console.log(`\nArrayBuffer size: ${arrayBuffer.byteLength} bytes`);

// Check first few bytes
const view = new DataView(arrayBuffer);
const firstChar = String.fromCharCode(view.getUint8(0));
console.log(`First char: '${firstChar}' (0x${view.getUint8(0).toString(16)})`);
console.log(`Is text format: ${firstChar === 'F'}`);

// Create parser
const parser = new DataflashParser(false);

// Process the data with all needed message types
const allMsgs = [
  'CMD', 'MSG', 'FILE', 'MODE', 'AHR2', 'ATT', 'GPS', 'POS',
  'XKQ1', 'XKQ', 'NKQ1', 'NKQ2', 'XKQ2', 'PARM', 'STAT', 'EV',
  'RATE', 'BARO', 'ESC', 'BAT', 'GPA', 'VIBE', 'RCIN', 'RCOU', 'XKF4'
];

console.log('\nParsing .log file...');
try {
  const result = parser.processData(arrayBuffer, allMsgs);

  console.log('\n=== Message Types Found ===');
  const typeNames = Object.keys(result.types);
  console.log(`Total message types: ${typeNames.length}`);
  console.log('Types:', typeNames.sort().join(', '));

  console.log('\n=== Chart-relevant Message Types ===');
  const chartTypes = ['ATT', 'RATE', 'BARO', 'ESC', 'BAT', 'GPA', 'VIBE', 'RCIN', 'RCOU', 'XKF4', 'GPS'];
  for (const ct of chartTypes) {
    const found = typeNames.includes(ct);
    const instances = typeNames.filter(t => t.startsWith(ct + '['));
    if (found) {
      const fields = result.types[ct].expressions || [];
      console.log(`  ✓ ${ct}: ${fields.join(', ')}`);
    } else if (instances.length > 0) {
      const fields = result.types[instances[0]].expressions || [];
      console.log(`  ✓ ${ct} (instances: ${instances.join(', ')}): ${fields.join(', ')}`);
    } else {
      console.log(`  ✗ ${ct}: NOT FOUND`);
    }
  }

  console.log('\n=== Parsed Messages ===');
  const msgNames = Object.keys(result.messages);
  console.log(`Total parsed message categories: ${msgNames.length}`);
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
  } else {
    // Check for ATT instances
    const attInstances = msgNames.filter(n => n.startsWith('ATT'));
    if (attInstances.length > 0) {
      console.log(`\n=== Sample ${attInstances[0]} Data (first 5 records) ===`);
      const att = result.messages[attInstances[0]];
      const fields = Object.keys(att);
      for (let i = 0; i < Math.min(5, att[fields[0]].length); i++) {
        const row = {};
        for (const f of fields) {
          row[f] = typeof att[f][i] === 'number' ? att[f][i].toFixed(4) : att[f][i];
        }
        console.log(`  [${i}]`, row);
      }
    } else {
      console.log('\n  No ATT data found');
    }
  }

  // Check stats
  console.log('\n=== Log Stats (top 15 by count) ===');
  const stats = parser.stats();
  if (stats && Object.keys(stats).length > 0) {
    for (const [name, info] of Object.entries(stats).sort((a, b) => b[1].count - a[1].count).slice(0, 15)) {
      console.log(`  ${name}: ${info.count} messages, ${info.msg_size || '?'} bytes/msg, ${((info.size || 0) / 1024).toFixed(1)} KB total`);
    }
  } else {
    console.log('  No stats available (text format may not track stats)');
  }

  // Now test the flight-charts functions
  console.log('\n=== Testing flight-charts functions ===');
  
  // Import flight-charts (need to check available charts)
  const flightChartsPath = '/home/ubuntu/rplidar_web_server/client/src/lib/flight-charts.ts';
  const flightChartsCode = fs.readFileSync(flightChartsPath, 'utf8');
  
  // Count available chart types from the parsed data
  const availableChartTypes = chartTypes.filter(ct => {
    return typeNames.includes(ct) || typeNames.some(t => t.startsWith(ct + '['));
  });
  console.log(`Chart-relevant types available: ${availableChartTypes.length}/${chartTypes.length}`);
  console.log(`Available: ${availableChartTypes.join(', ')}`);
  const missingTypes = chartTypes.filter(ct => !availableChartTypes.includes(ct));
  if (missingTypes.length > 0) {
    console.log(`Missing: ${missingTypes.join(', ')}`);
  }

  console.log('\n=== .LOG Parser Test PASSED ===');
} catch (err) {
  console.error('\n=== PARSING FAILED ===');
  console.error('Error:', err.message);
  console.error('Stack:', err.stack);
  process.exit(1);
}
