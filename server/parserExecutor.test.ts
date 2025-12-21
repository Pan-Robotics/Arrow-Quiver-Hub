import { describe, it, expect } from 'vitest';
import { executeParser, validateParserCode } from './parserExecutor';

describe('Parser Executor', () => {
  describe('validateParserCode', () => {
    it('should accept valid parser code', () => {
      const validCode = `
def parse_payload(raw_data: dict) -> dict:
    return {
        "temperature": raw_data.get("temp", 0) / 100.0
    }

SCHEMA = {
    "temperature": {"type": "number"}
}
`;
      const result = validateParserCode(validCode);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject code without parse_payload function', () => {
      const invalidCode = `
SCHEMA = {"temperature": {"type": "number"}}
`;
      const result = validateParserCode(invalidCode);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Parser must define a parse_payload function');
    });

    it('should reject code without SCHEMA', () => {
      const invalidCode = `
def parse_payload(raw_data: dict) -> dict:
    return {"temperature": 25.0}
`;
      const result = validateParserCode(invalidCode);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Parser must define a SCHEMA dictionary');
    });

    it('should reject code with dangerous imports', () => {
      const dangerousCode = `
import os
def parse_payload(raw_data: dict) -> dict:
    return {"temperature": 25.0}
SCHEMA = {"temperature": {"type": "number"}}
`;
      const result = validateParserCode(dangerousCode);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('os module'))).toBe(true);
    });

    it('should reject code with subprocess import', () => {
      const dangerousCode = `
import subprocess
def parse_payload(raw_data: dict) -> dict:
    return {"temperature": 25.0}
SCHEMA = {"temperature": {"type": "number"}}
`;
      const result = validateParserCode(dangerousCode);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('subprocess'))).toBe(true);
    });

    it('should reject code with eval', () => {
      const dangerousCode = `
def parse_payload(raw_data: dict) -> dict:
    result = eval("1+1")
    return {"temperature": result}
SCHEMA = {"temperature": {"type": "number"}}
`;
      const result = validateParserCode(dangerousCode);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('eval'))).toBe(true);
    });
  });

  describe('executeParser', () => {
    it('should execute valid parser code', async () => {
      const parserCode = `
def parse_payload(raw_data: dict) -> dict:
    return {
        "temperature": raw_data.get("temp_raw", 0) / 100.0,
        "humidity": raw_data.get("hum_raw", 0) / 100.0
    }

SCHEMA = {
    "temperature": {"type": "number", "unit": "°C"},
    "humidity": {"type": "number", "unit": "%"}
}
`;
      const testData = {
        temp_raw: 2350,
        hum_raw: 6500
      };

      const result = await executeParser(parserCode, testData);

      expect(result.success).toBe(true);
      expect(result.output).toEqual({
        temperature: 23.5,
        humidity: 65.0
      });
      expect(result.executionTime).toBeGreaterThan(0);
    }, 10000);

    it('should handle parser errors gracefully', async () => {
      const parserCode = `
def parse_payload(raw_data: dict) -> dict:
    raise ValueError("Test error")

SCHEMA = {"temperature": {"type": "number"}}
`;
      const testData = { temp_raw: 2350 };

      const result = await executeParser(parserCode, testData);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Test error');
    }, 10000);

    it('should handle invalid return types', async () => {
      const parserCode = `
def parse_payload(raw_data: dict) -> dict:
    return "not a dictionary"

SCHEMA = {"temperature": {"type": "number"}}
`;
      const testData = { temp_raw: 2350 };

      const result = await executeParser(parserCode, testData);

      expect(result.success).toBe(false);
      expect(result.error).toContain('must return a dictionary');
    }, 10000);

    it('should handle missing data gracefully', async () => {
      const parserCode = `
def parse_payload(raw_data: dict) -> dict:
    return {
        "temperature": raw_data.get("temp_raw", 0) / 100.0,
        "humidity": raw_data.get("hum_raw", 0) / 100.0
    }

SCHEMA = {
    "temperature": {"type": "number"},
    "humidity": {"type": "number"}
}
`;
      const testData = {}; // Empty data

      const result = await executeParser(parserCode, testData);

      expect(result.success).toBe(true);
      expect(result.output).toEqual({
        temperature: 0.0,
        humidity: 0.0
      });
    }, 10000);

    it('should execute within reasonable time', async () => {
      const parserCode = `
def parse_payload(raw_data: dict) -> dict:
    return {"value": raw_data.get("val", 0)}

SCHEMA = {"value": {"type": "number"}}
`;
      const testData = { val: 42 };

      const startTime = Date.now();
      const result = await executeParser(parserCode, testData);
      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(duration).toBeLessThan(2000); // Should complete in under 2 seconds
    }, 10000);
  });
});
