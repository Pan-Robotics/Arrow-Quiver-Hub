import { spawn, execSync } from 'child_process';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';

/**
 * Result of parser execution
 */
export interface ParserExecutionResult {
  success: boolean;
  output?: any;
  error?: string;
  executionTime?: number;
}

/**
 * Execute a Python parser script in a sandboxed environment
 * 
 * @param parserCode - Python code containing parse_payload function and SCHEMA
 * @param testData - JSON data to pass to the parser
 * @returns Execution result with output or error
 */
export async function executeParser(
  parserCode: string,
  testData: any
): Promise<ParserExecutionResult> {
  const startTime = Date.now();
  const tempDir = '/tmp/quiver_parsers';
  const sessionId = randomBytes(16).toString('hex');
  const parserPath = join(tempDir, `parser_${sessionId}.py`);
  const dataPath = join(tempDir, `data_${sessionId}.json`);

  try {
    // Ensure temp directory exists
    await mkdir(tempDir, { recursive: true });

    // Create wrapper script that imports user code and executes it
    const wrapperCode = `
import json
import sys
from typing import Any, Dict

# User's parser code
${parserCode}

# Load test data
with open('${dataPath}', 'r') as f:
    test_data = json.load(f)

try:
    # Execute parser
    result = parse_payload(test_data)
    
    # Validate result is a dictionary
    if not isinstance(result, dict):
        raise ValueError("parse_payload must return a dictionary")
    
    # Output result as JSON
    print(json.dumps({
        "success": True,
        "output": result,
        "schema": SCHEMA if 'SCHEMA' in dir() else None
    }))
    
except Exception as e:
    print(json.dumps({
        "success": False,
        "error": str(e),
        "error_type": type(e).__name__
    }))
    sys.exit(1)
`;

    // Write parser code and test data to temp files
    await writeFile(parserPath, wrapperCode, 'utf-8');
    await writeFile(dataPath, JSON.stringify(testData), 'utf-8');

    // Execute Python script with timeout
    const result = await executePython(parserPath, 5000); // 5 second timeout

    // Clean up temp files
    await Promise.all([
      unlink(parserPath).catch(() => {}),
      unlink(dataPath).catch(() => {})
    ]);

    const executionTime = Date.now() - startTime;

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        executionTime
      };
    }

    try {
      const output = JSON.parse(result.stdout);
      return {
        ...output,
        executionTime
      };
    } catch (e) {
      return {
        success: false,
        error: `Failed to parse parser output: ${result.stdout}`,
        executionTime
      };
    }

  } catch (error) {
    const executionTime = Date.now() - startTime;
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      executionTime
    };
  }
}

/**
 * Cached Python executable path
 */
let cachedPythonPath: string | null = null;

/**
 * Detect available Python executable
 * Tries python3.11, python3, python in order
 */
function detectPythonPath(): string {
  if (cachedPythonPath) {
    return cachedPythonPath;
  }

  const candidates = [
    'python3.11',
    'python3',
    'python'
  ];

  for (const candidate of candidates) {
    try {
      // Try to execute python --version to check if it exists
      execSync(`${candidate} --version`, { stdio: 'pipe' });
      cachedPythonPath = candidate;
      console.log(`[ParserExecutor] Using Python: ${candidate}`);
      return candidate;
    } catch (e) {
      // This candidate doesn't exist, try next
      continue;
    }
  }

  throw new Error(
    'No Python executable found. Tried: ' + candidates.join(', ') + '. ' +
    'Please ensure Python 3 is installed on the server.'
  );
}

/**
 * Execute Python script with timeout
 */
function executePython(scriptPath: string, timeout: number): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}> {
  return new Promise((resolve) => {
    let pythonPath: string;
    try {
      pythonPath = detectPythonPath();
    } catch (error) {
      resolve({
        success: false,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : 'Failed to detect Python'
      });
      return;
    }

    const python = spawn(pythonPath, [scriptPath], {
      timeout,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PYTHONUNBUFFERED: '1',
        // Clear Python-related env vars to avoid conflicts
        PYTHONPATH: undefined,
        PYTHONHOME: undefined
      }
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    python.on('close', (code) => {
      if (timedOut) {
        resolve({
          success: false,
          stdout: '',
          stderr: '',
          error: `Parser execution timed out after ${timeout}ms`
        });
      } else if (code === 0) {
        resolve({
          success: true,
          stdout,
          stderr
        });
      } else {
        // Try to parse error from stdout (JSON error message from wrapper)
        let errorMessage = stderr;
        try {
          const output = JSON.parse(stdout);
          if (output.error) {
            errorMessage = output.error;
          }
        } catch (e) {
          // If stdout is not JSON, use stderr
        }
        
        resolve({
          success: false,
          stdout,
          stderr,
          error: errorMessage || `Parser exited with code ${code}`
        });
      }
    });

    python.on('error', (error) => {
      resolve({
        success: false,
        stdout: '',
        stderr: '',
        error: `Failed to execute parser: ${error.message}`
      });
    });

    // Set timeout
    setTimeout(() => {
      timedOut = true;
      python.kill('SIGTERM');
      
      // Force kill after 1 second if still running
      setTimeout(() => {
        python.kill('SIGKILL');
      }, 1000);
    }, timeout);
  });
}

/**
 * Validate parser code for basic security issues
 * 
 * @param parserCode - Python code to validate
 * @returns Validation result
 */
export function validateParserCode(parserCode: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check for required function
  if (!parserCode.includes('def parse_payload')) {
    errors.push('Parser must define a parse_payload function');
  }

  // Check for required schema
  if (!parserCode.includes('SCHEMA')) {
    errors.push('Parser must define a SCHEMA dictionary');
  }

  // Basic security checks (blacklist dangerous operations)
  const dangerousPatterns = [
    { pattern: /import\s+os/i, message: 'Importing os module is not allowed' },
    { pattern: /import\s+subprocess/i, message: 'Importing subprocess module is not allowed' },
    { pattern: /import\s+sys/i, message: 'Importing sys module is not allowed (except in wrapper)' },
    { pattern: /exec\s*\(/i, message: 'Using exec() is not allowed' },
    { pattern: /eval\s*\(/i, message: 'Using eval() is not allowed' },
    { pattern: /__import__/i, message: 'Using __import__ is not allowed' },
    { pattern: /open\s*\(/i, message: 'File operations are not allowed' },
  ];

  for (const { pattern, message } of dangerousPatterns) {
    if (pattern.test(parserCode)) {
      errors.push(message);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
