import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

export interface SchemaField {
  type: "number" | "string" | "boolean" | "array";
  unit?: string;
  description?: string;
  min?: number;
  max?: number;
  format?: string;
}

export type DataSchema = Record<string, SchemaField>;

/**
 * Extract SCHEMA definition from Python parser code by executing it
 */
export async function extractSchema(parserCode: string): Promise<{
  success: boolean;
  schema?: DataSchema;
  error?: string;
}> {
  const tempDir = path.join(os.tmpdir(), "quiver_schema_extraction");
  await fs.mkdir(tempDir, { recursive: true });

  const scriptPath = path.join(tempDir, `extract_${Date.now()}.py`);

  try {
    // Create a Python script that extracts the SCHEMA
    const extractorScript = `
import json
import sys

# User's parser code
${parserCode}

# Extract SCHEMA
if 'SCHEMA' in globals():
    schema = SCHEMA
    print(json.dumps(schema))
else:
    print(json.dumps({"error": "SCHEMA not defined"}), file=sys.stderr)
    sys.exit(1)
`;

    await fs.writeFile(scriptPath, extractorScript, "utf-8");

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";

      const pythonProcess = spawn("/usr/bin/python3.11", [scriptPath], {
        timeout: 5000,
        env: {
          PATH: "/usr/bin:/bin",
          PYTHONPATH: "",
          PYTHONHOME: "",
        },
      });

      pythonProcess.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      pythonProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      pythonProcess.on("close", async (code) => {
        // Clean up
        try {
          await fs.unlink(scriptPath);
        } catch (e) {
          // Ignore cleanup errors
        }

        if (code !== 0) {
          resolve({
            success: false,
            error: `Schema extraction failed: ${stderr || "Unknown error"}`,
          });
          return;
        }

        try {
          const schema = JSON.parse(stdout.trim()) as DataSchema;
          
          // Validate schema structure
          for (const [field, config] of Object.entries(schema)) {
            if (!config.type || !["number", "string", "boolean", "array"].includes(config.type)) {
              resolve({
                success: false,
                error: `Invalid type for field "${field}": ${config.type}`,
              });
              return;
            }
          }

          resolve({
            success: true,
            schema,
          });
        } catch (error) {
          resolve({
            success: false,
            error: `Failed to parse schema JSON: ${error instanceof Error ? error.message : "Unknown error"}`,
          });
        }
      });

      pythonProcess.on("error", async (error) => {
        // Clean up
        try {
          await fs.unlink(scriptPath);
        } catch (e) {
          // Ignore cleanup errors
        }

        resolve({
          success: false,
          error: `Failed to execute Python: ${error.message}`,
        });
      });
    });
  } catch (error) {
    // Clean up on error
    try {
      await fs.unlink(scriptPath);
    } catch (e) {
      // Ignore cleanup errors
    }

    return {
      success: false,
      error: `Failed to create extraction script: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}
