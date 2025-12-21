import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { ArrowLeft, Upload, Play, Save } from "lucide-react";
import { trpc } from "@/lib/trpc";

interface DataField {
  name: string;
  type: "number" | "string" | "boolean";
  unit?: string;
  description?: string;
}

interface AppBuilderProps {
  onBack: () => void;
}

export default function AppBuilder({ onBack }: AppBuilderProps) {
  const [appName, setAppName] = useState("");
  const [appDescription, setAppDescription] = useState("");
  const [parserCode, setParserCode] = useState(
    `# Payload Parser Template
# This function receives raw data and returns structured output

def parse_payload(raw_data: dict) -> dict:
    """
    Transform raw incoming data into structured format.
    
    Args:
        raw_data: Dictionary containing raw payload data
        
    Returns:
        Dictionary with structured data matching your schema
    """
    # Example: Extract and transform data
    return {
        "temperature": raw_data.get("temp_raw", 0) / 100.0,
        "humidity": raw_data.get("hum_raw", 0) / 100.0,
        "timestamp": raw_data.get("ts", "")
    }

# Define your data schema
SCHEMA = {
    "temperature": {
        "type": "number",
        "unit": "°C",
        "description": "Temperature in Celsius"
    },
    "humidity": {
        "type": "number", 
        "unit": "%",
        "description": "Relative humidity"
    },
    "timestamp": {
        "type": "string",
        "description": "ISO 8601 timestamp"
    }
}
`
  );
  const [testData, setTestData] = useState(
    JSON.stringify({ temp_raw: 2350, hum_raw: 6500, ts: "2025-01-01T12:00:00Z" }, null, 2)
  );
  const [testResult, setTestResult] = useState<string>("");
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const testParserMutation = trpc.appBuilder.testParser.useMutation();

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

  const handleSave = async () => {
    if (!appName.trim()) {
      toast.error("Please enter an app name");
      return;
    }
    
    if (!parserCode.trim()) {
      toast.error("Please enter parser code");
      return;
    }

    setIsSaving(true);
    
    try {
      // TODO: Save to backend
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      toast.success("App saved successfully!");
      onBack();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to save: ${message}`);
    } finally {
      setIsSaving(false);
    }
  };

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
            <div className="space-y-2">
              <Label htmlFor="parserCode">Parser Code (Python)</Label>
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
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? (
              <>Saving...</>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                Save App
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
