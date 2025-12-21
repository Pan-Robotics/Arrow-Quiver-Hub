import UIBuilder from "./UIBuilder";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { ArrowLeft, Upload, Play, Save, FileUp } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useRef, useState, useEffect } from "react";

interface DataField {
  name: string;
  type: "number" | "string" | "boolean";
  unit?: string;
  description?: string;
}

interface AppBuilderProps {
  onBack: () => void;
}

const STORAGE_KEY = "appBuilder_formData";

const DEFAULT_PARSER_TEMPLATE = `# Payload Parser Template
# Transform raw payload data into structured format for UI visualization
#
# FOR QUIVER EDGE DEPLOYMENT:
# See docs/QUIVER_DEPLOYMENT_TEMPLATE.md for complete Flask/FastAPI server setup
# to run this parser autonomously on Quiver devices with automatic data forwarding
#
# OUTPUT FORMAT REQUIREMENTS:
# 1. parse_payload() must return a dictionary
# 2. All output fields must be defined in SCHEMA
# 3. Field types: "number", "string", or "boolean"
# 4. Include units for number fields (e.g., "°C", "km/h", "%")
# 5. Set min/max for gauges and charts
#
# See docs/PARSER_OUTPUT_FORMAT.md for complete specification

def parse_payload(raw_data: dict) -> dict:
    """
    Transform raw incoming data into structured format.
    
    Args:
        raw_data: Dictionary containing raw payload data
        
    Returns:
        Dictionary with structured data matching SCHEMA
        
    Example input:
        {"temp_raw": 2350, "hum_raw": 6500, "ts": "2025-01-01T12:00:00Z"}
    
    Example output:
        {"temperature": 23.5, "humidity": 65.0, "timestamp": "2025-01-01T12:00:00Z"}
    """
    # Extract and transform data with defaults
    return {
        "temperature": raw_data.get("temp_raw", 0) / 100.0,
        "humidity": raw_data.get("hum_raw", 0) / 100.0,
        "timestamp": raw_data.get("ts", "")
    }

# Define output schema - REQUIRED for UI Builder
# This tells the UI what fields are available and how to display them
SCHEMA = {
    "temperature": {
        "type": "number",
        "unit": "°C",
        "description": "Temperature in Celsius",
        "min": -50,
        "max": 60
    },
    "humidity": {
        "type": "number", 
        "unit": "%",
        "description": "Relative humidity",
        "min": 0,
        "max": 100
    },
    "timestamp": {
        "type": "string",
        "description": "ISO 8601 timestamp",
        "format": "iso8601"
    }
}
`;

const DEFAULT_TEST_DATA = JSON.stringify({ temp_raw: 2350, hum_raw: 6500, ts: "2025-01-01T12:00:00Z" }, null, 2);

export default function AppBuilder({ onBack }: AppBuilderProps) {
  // Load saved form data from localStorage
  const loadSavedData = () => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (error) {
      console.error('Failed to load saved form data:', error);
    }
    return null;
  };

  const savedData = loadSavedData();

  const [appName, setAppName] = useState(savedData?.appName || "");
  const [appDescription, setAppDescription] = useState(savedData?.appDescription || "");
  const [parserCode, setParserCode] = useState(savedData?.parserCode || DEFAULT_PARSER_TEMPLATE);
  const [testData, setTestData] = useState(savedData?.testData || DEFAULT_TEST_DATA);
  const [testResult, setTestResult] = useState<string>("");
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showUIBuilder, setShowUIBuilder] = useState(false);
  const [parsedSchema, setParsedSchema] = useState<Record<string, any> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Save form data to localStorage whenever it changes
  useEffect(() => {
    const formData = {
      appName,
      appDescription,
      parserCode,
      testData,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(formData));
      console.log('[AppBuilder] Form data saved to localStorage');
    } catch (error) {
      console.error('[AppBuilder] Failed to save form data:', error);
    }
  }, [appName, appDescription, parserCode, testData]);

  // Clear saved data when component unmounts after successful save
  const clearSavedData = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
      console.log('[AppBuilder] Cleared saved form data');
    } catch (error) {
      console.error('[AppBuilder] Failed to clear saved data:', error);
    }
  };

  const testParserMutation = trpc.appBuilder.testParser.useMutation();
  const extractSchemaMutation = trpc.appBuilder.extractSchema.useMutation();

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Check file extension
    if (!file.name.endsWith('.py')) {
      toast.error('Please upload a .py file');
      return;
    }

    // Check file size (max 1MB)
    if (file.size > 1024 * 1024) {
      toast.error('File size must be less than 1MB');
      return;
    }

    // Read file content
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      setParserCode(content);
      toast.success(`Loaded ${file.name}`);
    };
    reader.onerror = () => {
      toast.error('Failed to read file');
    };
    reader.readAsText(file);

    // Reset input so same file can be uploaded again
    if (event.target) {
      event.target.value = '';
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult("");
    
    try {
      // Parse test data
      const testDataObj = JSON.parse(testData);
      
      // Send to backend for execution
      const result = await testParserMutation.mutateAsync({
        parserCode,
        testData: testDataObj
      });
      
      if (result.success) {
        setTestResult(JSON.stringify(result.output, null, 2));
        toast.success(`Parser test successful! (${result.executionTime}ms)`);
      } else {
        setTestResult(`Error: ${result.error}`);
        toast.error(`Test failed: ${result.error}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      toast.error(`Test failed: ${message}`);
      setTestResult(`Error: ${message}`);
    } finally {
      setIsTesting(false);
    }
  };

  const handleContinueToUI = async () => {
    console.log('handleContinueToUI called');
    console.log('appName:', appName);
    console.log('parserCode length:', parserCode.length);
    
    if (!appName.trim()) {
      console.log('Validation failed: appName is empty');
      toast.error("Please enter an app name");
      return;
    }
    
    console.log('appName validation passed');
    
    if (!parserCode.trim()) {
      console.log('Validation failed: parserCode is empty');
      toast.error("Please enter parser code");
      return;
    }
    
    console.log('parserCode validation passed');

    try {
      console.log('Extracting schema from parser code...');
      toast.info("Extracting schema from parser...");
      
      // Extract SCHEMA from parser code using backend
      const schemaResult = await extractSchemaMutation.mutateAsync({
        parserCode
      });
      
      console.log('Schema extraction result:', schemaResult);
      
      if (!schemaResult.success || !schemaResult.schema) {
        console.error('Schema extraction failed:', schemaResult.error);
        toast.error(schemaResult.error || "Failed to extract SCHEMA from parser code");
        return;
      }

      console.log('Setting parsed schema:', schemaResult.schema);
      setParsedSchema(schemaResult.schema);
      setShowUIBuilder(true);
      console.log('UI Builder should now be visible');
      toast.success("Parser validated! Now design your UI");
    } catch (error) {
      console.error('Error in handleContinueToUI:', error);
      const message = error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to extract schema: ${message}`);
    }
  };

  const saveAppMutation = trpc.appBuilder.saveApp.useMutation();

  const handleSaveUI = async (uiSchema: any) => {
    setIsSaving(true);
    
    try {
      // Save to backend with parser, data schema, and UI schema
      const result = await saveAppMutation.mutateAsync({
        name: appName,
        description: appDescription || undefined,
        parserCode,
        dataSchema: parsedSchema,
        uiSchema,
      });
      
      toast.success(`App "${appName}" saved successfully!`);
      console.log('Saved app:', result);
      clearSavedData(); // Clear form data after successful save
      onBack();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to save: ${message}`);
    } finally {
      setIsSaving(false);
    }
  };

  // Show UI Builder if schema is parsed
  if (showUIBuilder && parsedSchema) {
    return (
      <UIBuilder
        dataSchema={parsedSchema}
        onSave={handleSaveUI}
        onCancel={() => setShowUIBuilder(false)}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold">App Builder</h1>
            <p className="text-muted-foreground">Create a custom data pipeline app</p>
          </div>
        </div>

        {/* App Info */}
        <Card>
          <CardHeader>
            <CardTitle>App Information</CardTitle>
            <CardDescription>Basic details about your app</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="appName">App Name</Label>
              <Input
                id="appName"
                placeholder="e.g., Weather Station"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="appDescription">Description</Label>
              <Textarea
                id="appDescription"
                placeholder="Describe what your app does..."
                value={appDescription}
                onChange={(e) => setAppDescription(e.target.value)}
                rows={3}
              />
            </div>
          </CardContent>
        </Card>

        {/* Parser Code */}
        <Card>
          <CardHeader>
            <CardTitle>Payload Parser</CardTitle>
            <CardDescription>
              Python code to transform raw payload data into structured format
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2 mb-2">
              <Label htmlFor="parserCode">Parser Code (Python)</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".py"
                onChange={handleFileUpload}
                className="hidden"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                className="ml-auto"
              >
                <FileUp className="h-4 w-4 mr-2" />
                Upload .py File
              </Button>
            </div>
            <div className="space-y-2">
              <Textarea
                id="parserCode"
                value={parserCode}
                onChange={(e) => setParserCode(e.target.value)}
                rows={20}
                className="font-mono text-sm"
              />
            </div>
          </CardContent>
        </Card>

        {/* Test Parser */}
        <Card>
          <CardHeader>
            <CardTitle>Test Parser</CardTitle>
            <CardDescription>Test your parser with sample data</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="testData">Test Input (JSON)</Label>
                <Textarea
                  id="testData"
                  value={testData}
                  onChange={(e) => setTestData(e.target.value)}
                  rows={10}
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="testResult">Test Output</Label>
                <Textarea
                  id="testResult"
                  value={testResult}
                  readOnly
                  rows={10}
                  className="font-mono text-sm bg-muted"
                  placeholder="Test output will appear here..."
                />
              </div>
            </div>
            <Button onClick={handleTest} disabled={isTesting}>
              {isTesting ? (
                <>Testing...</>
              ) : (
                <>
                  <Play className="h-4 w-4 mr-2" />
                  Test Parser
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex justify-end gap-4">
          <Button variant="outline" onClick={onBack}>
            Cancel
          </Button>
          <Button onClick={handleContinueToUI}>
            Continue to UI Builder
          </Button>
        </div>
      </div>
    </div>
  );
}
