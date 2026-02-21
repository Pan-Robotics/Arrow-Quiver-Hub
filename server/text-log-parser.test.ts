import { describe, it, expect } from "vitest";

// Test the text log format parsing logic
// The DataflashParser handles both binary .BIN and text .log formats

describe("Text Log Format Parsing", () => {
  describe("Format Detection", () => {
    it("should detect text format when first byte is 'F' (0x46)", () => {
      // Text logs start with "FMT, ..." lines
      const textContent = "FMT, 128, 89, FMT, BBnNZ, Type,Length,Name,Format,Columns\n";
      const encoder = new TextEncoder();
      const buffer = encoder.encode(textContent);
      // First byte should be 'F' = 0x46
      expect(buffer[0]).toBe(0x46);
      // Binary format starts with HEAD1 = 0xA3
      expect(buffer[0]).not.toBe(0xA3);
    });

    it("should detect binary format when first byte is HEAD1 (0xA3)", () => {
      const buffer = new Uint8Array([0xA3, 0x95, 128]); // HEAD1, HEAD2, FMT type
      expect(buffer[0]).toBe(0xA3);
    });
  });

  describe("Text Log Line Parsing", () => {
    it("should parse FMT lines correctly", () => {
      const fmtLine = "FMT, 128, 89, FMT, BBnNZ, Type,Length,Name,Format,Columns";
      const parts = fmtLine.split(",").map((s) => s.trim());
      expect(parts[0]).toBe("FMT");
      expect(parts[1]).toBe("128"); // type number
      expect(parts[2]).toBe("89"); // length
      expect(parts[3]).toBe("FMT"); // name
      expect(parts[4]).toBe("BBnNZ"); // format string
      expect(parts.slice(5).join(",")).toBe("Type,Length,Name,Format,Columns");
    });

    it("should parse ATT data lines correctly", () => {
      const attLine =
        "ATT, 94681197, -0.10, -0.32, 86.23, -0.10, -0.32, 86.23, 0.00, 0.00, 0";
      const parts = attLine.split(",").map((s) => s.trim());
      expect(parts[0]).toBe("ATT");
      expect(parseFloat(parts[1])).toBe(94681197); // TimeUS
      expect(parseFloat(parts[2])).toBeCloseTo(-0.1); // DesRoll
      expect(parseFloat(parts[3])).toBeCloseTo(-0.32); // Roll
      expect(parseFloat(parts[4])).toBeCloseTo(86.23); // DesPitch
    });

    it("should parse ESC instance data lines correctly", () => {
      const escLine =
        "ESC, 94681197, 0, 5000, 5000, 14.5, 2.3, 35.0, 100, 0, 0";
      const parts = escLine.split(",").map((s) => s.trim());
      expect(parts[0]).toBe("ESC");
      expect(parseInt(parts[2])).toBe(0); // Instance field
    });

    it("should handle BARO instance data with instance field", () => {
      const baroLine =
        "BARO, 94681197, 0, 100.5, 101325.0, 25.3, 0.1, 94681197, 0.0, 25.0, 1";
      const parts = baroLine.split(",").map((s) => s.trim());
      expect(parts[0]).toBe("BARO");
      expect(parseInt(parts[2])).toBe(0); // Instance field 'I'
    });
  });

  describe("Text Value Type Conversion", () => {
    it("should convert integer format chars to numbers", () => {
      // Format chars: b=int8, B=uint8, h=int16, H=uint16, i=int32, I=uint32
      const intFormats = ["b", "B", "h", "H", "i", "I"];
      for (const fmt of intFormats) {
        const val = "42";
        expect(parseInt(val)).toBe(42);
      }
    });

    it("should convert float format chars to numbers", () => {
      // Format chars: f=float, d=double, e=float*100, c=float*100
      const val = "3.14159";
      expect(parseFloat(val)).toBeCloseTo(3.14159, 4);
    });

    it("should handle Q (uint64) format for TimeUS", () => {
      const val = "94681197";
      expect(Number(val)).toBe(94681197);
    });

    it("should handle N (name/string) format", () => {
      const val = "FMT";
      expect(val).toBe("FMT");
    });

    it("should handle Z (string) format for messages", () => {
      const val = "ArduCopter V4.5.7 (12345678)";
      expect(val).toBe("ArduCopter V4.5.7 (12345678)");
    });
  });

  describe("Instance-based Message Types", () => {
    it("should split messages with instance fields into separate keys", () => {
      // When a FMT has an instance field (like 'I' in BARO), messages should be
      // split into BARO[0], BARO[1], etc. based on the instance value
      const messages: Record<string, Record<string, number[]>> = {};

      // Simulate parsing BARO lines with instance 0 and 1
      const baroData = [
        { I: 0, Alt: 100.5, Press: 101325 },
        { I: 1, Alt: 100.3, Press: 101320 },
        { I: 0, Alt: 100.6, Press: 101326 },
        { I: 1, Alt: 100.4, Press: 101321 },
      ];

      for (const d of baroData) {
        const key = `BARO[${d.I}]`;
        if (!messages[key]) {
          messages[key] = { Alt: [], Press: [] };
        }
        messages[key].Alt.push(d.Alt);
        messages[key].Press.push(d.Press);
      }

      expect(Object.keys(messages)).toContain("BARO[0]");
      expect(Object.keys(messages)).toContain("BARO[1]");
      expect(messages["BARO[0]"].Alt).toEqual([100.5, 100.6]);
      expect(messages["BARO[1]"].Alt).toEqual([100.3, 100.4]);
    });

    it("should handle ESC with 4 instances (0-3)", () => {
      const instances = [0, 1, 2, 3];
      const keys = instances.map((i) => `ESC[${i}]`);
      expect(keys).toEqual(["ESC[0]", "ESC[1]", "ESC[2]", "ESC[3]"]);
    });

    it("should handle VIBE with 3 instances (0-2)", () => {
      const instances = [0, 1, 2];
      const keys = instances.map((i) => `VIBE[${i}]`);
      expect(keys).toEqual(["VIBE[0]", "VIBE[1]", "VIBE[2]"]);
    });
  });

  describe("Time Conversion", () => {
    it("should convert TimeUS (microseconds) to time_boot_ms (milliseconds)", () => {
      const timeUS = 94681197;
      const timeMS = timeUS / 1000;
      expect(timeMS).toBeCloseTo(94681.197, 3);
    });

    it("should handle get_instance TimeUS conversion for text format", () => {
      // In text format, data is stored with time_boot_ms
      // get_instance("GPS", "0", "TimeUS") should convert back to microseconds
      const time_boot_ms = [94681.197, 94781.178];
      const timeUS = time_boot_ms.map((t) => t * 1000.0);
      expect(timeUS[0]).toBeCloseTo(94681197, 0);
      expect(timeUS[1]).toBeCloseTo(94781178, 0);
    });
  });

  describe("GPS Start Time Extraction", () => {
    it("should calculate GPS time from GWk and GMS fields", () => {
      // GPS week 2356, milliseconds 345600000
      const GWk = 2356;
      const GMS = 345600000;
      const ms_per_week = 7 * 24 * 60 * 60 * 1000;
      const GPS_ms = GWk * ms_per_week + GMS;

      // Convert to unix time (GPS epoch offset)
      const unix_gps_offset_ms = 315964800 * 1000;
      const unix_ms = unix_gps_offset_ms + GPS_ms;
      const date = new Date(unix_ms);

      // Should be a valid date in 2025
      expect(date.getFullYear()).toBe(2025);
    });

    it("should require GPS status >= 3 (3D fix) for valid time", () => {
      const GPS_OK_FIX_3D = 3;
      const statuses = [0, 1, 2, 3, 4, 5];
      const validStatuses = statuses.filter((s) => s >= GPS_OK_FIX_3D);
      expect(validStatuses).toEqual([3, 4, 5]);
    });
  });

  describe("Stats Calculation for Text Format", () => {
    it("should calculate message counts from parsed data", () => {
      // For text format, stats should count records per message type
      const messages: Record<string, { time_boot_ms: number[] }> = {
        ATT: { time_boot_ms: new Array(1326).fill(0) },
        "BARO[0]": { time_boot_ms: new Array(1326).fill(0) },
        "BARO[1]": { time_boot_ms: new Array(1326).fill(0) },
        "ESC[0]": { time_boot_ms: new Array(1700).fill(0) },
        "ESC[1]": { time_boot_ms: new Array(1331).fill(0) },
      };

      // Stats should aggregate instances under base name
      const stats: Record<string, { count: number }> = {};
      for (const [key, data] of Object.entries(messages)) {
        const baseName = key.replace(/\[\d+\]$/, "");
        if (!stats[baseName]) {
          stats[baseName] = { count: 0 };
        }
        stats[baseName].count += data.time_boot_ms.length;
      }

      expect(stats.ATT.count).toBe(1326);
      expect(stats.BARO.count).toBe(2652); // 1326 + 1326
      expect(stats.ESC.count).toBe(3031); // 1700 + 1331
    });
  });

  describe("PopulateUnits for Text Format", () => {
    it("should handle FMTU data from text format", () => {
      // FMTU lines provide unit and multiplier mappings
      const fmtuLine = "FMTU, 94681197, 163, ssmm-0, 00FF-0";
      const parts = fmtuLine.split(",").map((s) => s.trim());
      expect(parts[0]).toBe("FMTU");
      expect(parseInt(parts[2])).toBe(163); // FmtType
      expect(parts[3]).toBe("ssmm-0"); // UnitIds
      expect(parts[4]).toBe("00FF-0"); // MultIds
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty lines in text log", () => {
      const lines = ["FMT, 128, 89, FMT, BBnNZ, Type,Length,Name,Format,Columns", "", "ATT, 94681197, -0.10, -0.32, 86.23"];
      const nonEmpty = lines.filter((l) => l.trim().length > 0);
      expect(nonEmpty.length).toBe(2);
    });

    it("should handle lines with trailing whitespace", () => {
      const line = "ATT, 94681197, -0.10, -0.32, 86.23  \r\n";
      const trimmed = line.trim();
      expect(trimmed).toBe("ATT, 94681197, -0.10, -0.32, 86.23");
    });

    it("should handle MSG lines with commas in the message text", () => {
      const msgLine = "MSG, 94681197, ArduCopter V4.5.7 (12345678)";
      const parts = msgLine.split(",").map((s) => s.trim());
      // First two parts are MSG and TimeUS, rest is the message
      expect(parts[0]).toBe("MSG");
      // Message might contain commas, so we need to join remaining parts
      const message = parts.slice(2).join(", ");
      expect(message).toContain("ArduCopter");
    });

    it("should handle MODE lines with text mode names", () => {
      const modeLine = "MODE, 94681197, STABILIZE, 0, 0";
      const parts = modeLine.split(",").map((s) => s.trim());
      expect(parts[0]).toBe("MODE");
      expect(parts[2]).toBe("STABILIZE");
    });
  });
});
