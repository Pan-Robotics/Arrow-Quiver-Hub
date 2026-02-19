import UIBuilder from "./UIBuilder";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ArrowLeft, Play, FileUp, Radio, Code, Zap, Check, ChevronRight, Info } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useRef, useState, useEffect, useMemo } from "react";

interface AppBuilderProps {
  onBack: () => void;
  editMode?: boolean;
  editingAppId?: string;
}

type DataSourceType = "custom_endpoint" | "stream_subscription" | "passthrough";

interface StreamConfig {
  streamId: string;
  streamEvent: string;
  subscribeEvent: string;
  subscribeParam: string;
  fieldMappings: Record<string, string>; // widgetField -> streamField
}

const STORAGE_KEY = "appBuilder_formData";

const DEFAULT_PARSER_TEMPLATE = `# Payload Parser Template
# Transform raw payload data into structured format for UI visualization
#
# OUTPUT FORMAT REQUIREMENTS:
# 1. parse_payload() must return a dictionary
# 2. All output fields must be defined in SCHEMA
# 3. Field types: "number", "string", or "boolean"
# 4. Include units for number fields (e.g., "°C", "km/h", "%")

def parse_payload(raw_data: dict) -> dict:
    """Transform raw incoming data into structured format."""
    return {
        "temperature": raw_data.get("temp_raw", 0) / 100.0,
        "humidity": raw_data.get("hum_raw", 0) / 100.0,
        "timestamp": raw_data.get("ts", "")
    }

# Define output schema - REQUIRED for UI Builder
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
        "description": "ISO 8601 timestamp"
    }
}
`;

const DEFAULT_TEST_DATA = JSON.stringify({ temp_raw: 2350, hum_raw: 6500, ts: "2025-01-01T12:00:00Z" }, null, 2);

export default function AppBuilder({ onBack, editMode, editingAppId }: AppBuilderProps) {
  const { data: existingApp, isLoading: loadingApp } = trpc.appBuilder.getAppById.useQuery(
    { appId: editingAppId! },
    { enabled: !!editingAppId && editMode }
  );

  // Fetch available streams
  const { data: availableStreams } = trpc.appBuilder.getAvailableStreams.useQuery();

  // Load saved form data from localStorage
  const loadSavedData = () => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return JSON.parse(saved);
    } catch (error) {
      console.error('Failed to load saved form data:', error);
    }
    return null;
  };

  const savedData = loadSavedData();

  const [appName, setAppName] = useState(savedData?.appName || "");
  const [appDescription, setAppDescription] = useState(savedData?.appDescription || "");
  const [dataSource, setDataSource] = useState<DataSourceType>(savedData?.dataSource || "custom_endpoint");
  const [selectedStreamId, setSelectedStreamId] = useState<string>(savedData?.selectedStreamId || "");
  const [streamConfig, setStreamConfig] = useState<StreamConfig | null>(savedData?.streamConfig || null);
  const [parserCode, setParserCode] = useState(savedData?.parserCode || DEFAULT_PARSER_TEMPLATE);
  const [testData, setTestData] = useState(savedData?.testData || DEFAULT_TEST_DATA);

  // Load existing app data when in edit mode
  useEffect(() => {
    if (editMode && existingApp) {
      setAppName(existingApp.name);
      setAppDescription(existingApp.description || "");
      setParserCode(existingApp.parserCode);
      if ((existingApp as any).dataSource) {
        setDataSource((existingApp as any).dataSource);
      }
      if ((existingApp as any).dataSourceConfig) {
        try {
          const config = typeof (existingApp as any).dataSourceConfig === 'string'
            ? JSON.parse((existingApp as any).dataSourceConfig)
            : (existingApp as any).dataSourceConfig;
          setStreamConfig(config);
          if (config?.streamId) setSelectedStreamId(config.streamId);
        } catch (e) {
          console.error('Failed to parse dataSourceConfig:', e);
        }
      }
      if (existingApp.dataSchema) {
        try {
          const schemaObj = typeof existingApp.dataSchema === 'string'
            ? JSON.parse(existingApp.dataSchema)
            : existingApp.dataSchema;
          setParsedSchema(schemaObj);
        } catch (e) {
          console.error('Failed to parse existing schema:', e);
        }
      }
    }
  }, [editMode, existingApp]);

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
      dataSource,
      selectedStreamId,
      streamConfig,
      parserCode,
      testData,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(formData));
    } catch (error) {
      console.error('[AppBuilder] Failed to save form data:', error);
    }
  }, [appName, appDescription, dataSource, selectedStreamId, streamConfig, parserCode, testData]);

  const clearSavedData = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.error('[AppBuilder] Failed to clear saved data:', error);
    }
  };

  const testParserMutation = trpc.appBuilder.testParser.useMutation();
  const extractSchemaMutation = trpc.appBuilder.extractSchema.useMutation();

  // Get the selected stream object
  const selectedStream = useMemo(() => {
    if (!availableStreams || !selectedStreamId) return null;
    return availableStreams.find(s => s.id === selectedStreamId) || null;
  }, [availableStreams, selectedStreamId]);

  // Re-derive parsedSchema when streams load and a stream was previously selected (e.g., from localStorage)
  useEffect(() => {
    if (dataSource === 'stream_subscription' && selectedStreamId && availableStreams && !parsedSchema) {
      const stream = availableStreams.find(s => s.id === selectedStreamId);
      if (stream) {
        const schema: Record<string, any> = {};
        const fieldMappings: Record<string, string> = {};
        for (const [fieldPath, fieldInfo] of Object.entries(stream.fields)) {
          const simpleName = fieldPath.includes('.') ? fieldPath.split('.').pop()! : fieldPath;
          schema[simpleName] = { type: fieldInfo.type, description: fieldInfo.description };
          fieldMappings[simpleName] = fieldPath;
        }
        setParsedSchema(schema);
        if (!streamConfig) {
          setStreamConfig({
            streamId: stream.id,
            streamEvent: stream.event,
            subscribeEvent: stream.subscribeEvent,
            subscribeParam: stream.subscribeParam,
            fieldMappings,
          });
        }
      }
    }
  }, [dataSource, selectedStreamId, availableStreams, parsedSchema, streamConfig]);

  // When a stream is selected, build the schema from its fields and create streamConfig
  const handleStreamSelect = (streamId: string) => {
    setSelectedStreamId(streamId);
    const stream = availableStreams?.find(s => s.id === streamId);
    if (!stream) return;

    // Build schema from stream fields
    const schema: Record<string, any> = {};
    const fieldMappings: Record<string, string> = {};

    for (const [fieldPath, fieldInfo] of Object.entries(stream.fields)) {
      // Use the last part of the path as the field name for the widget
      const simpleName = fieldPath.includes('.') ? fieldPath.split('.').pop()! : fieldPath;
      schema[simpleName] = {
        type: fieldInfo.type,
        description: fieldInfo.description,
      };
      fieldMappings[simpleName] = fieldPath;
    }

    setParsedSchema(schema);
    setStreamConfig({
      streamId: stream.id,
      streamEvent: stream.event,
      subscribeEvent: stream.subscribeEvent,
      subscribeParam: stream.subscribeParam,
      fieldMappings,
    });
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.py')) {
      toast.error('Please upload a .py file');
      return;
    }
    if (file.size > 1024 * 1024) {
      toast.error('File size must be less than 1MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      setParserCode(content);
      toast.success(`Loaded ${file.name}`);
    };
    reader.onerror = () => toast.error('Failed to read file');
    reader.readAsText(file);
    if (event.target) event.target.value = '';
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult("");
    try {
      const testDataObj = JSON.parse(testData);
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
    if (!appName.trim()) {
      toast.error("Please enter an app name");
      return;
    }

    // For stream_subscription, schema is already set from the stream
    if (dataSource === 'stream_subscription') {
      if (!selectedStreamId || !streamConfig) {
        toast.error("Please select a data stream");
        return;
      }
      if (!parsedSchema) {
        toast.error("No schema available from selected stream");
        return;
      }
      setShowUIBuilder(true);
      toast.success("Stream configured! Now design your UI");
      return;
    }

    // For passthrough, we need the user to define a manual schema
    if (dataSource === 'passthrough') {
      if (!parserCode.trim()) {
        toast.error("Please define a SCHEMA in the code editor (no parse_payload function needed)");
        return;
      }
      // Try to extract just the SCHEMA
      try {
        toast.info("Extracting schema...");
        const schemaResult = await extractSchemaMutation.mutateAsync({ parserCode });
        if (!schemaResult.success || !schemaResult.schema) {
          toast.error(schemaResult.error || "Failed to extract SCHEMA");
          return;
        }
        setParsedSchema(schemaResult.schema);
        setShowUIBuilder(true);
        toast.success("Schema validated! Now design your UI");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        toast.error(`Failed to extract schema: ${message}`);
      }
      return;
    }

    // For custom_endpoint, validate parser code
    if (!parserCode.trim()) {
      toast.error("Please enter parser code");
      return;
    }
    try {
      toast.info("Extracting schema from parser...");
      const schemaResult = await extractSchemaMutation.mutateAsync({ parserCode });
      if (!schemaResult.success || !schemaResult.schema) {
        toast.error(schemaResult.error || "Failed to extract SCHEMA from parser code");
        return;
      }
      setParsedSchema(schemaResult.schema);
      setShowUIBuilder(true);
      toast.success("Parser validated! Now design your UI");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to extract schema: ${message}`);
    }
  };

  const saveAppMutation = trpc.appBuilder.saveApp.useMutation();
  const updateAppMutation = trpc.appBuilder.updateApp.useMutation();

  const handleSaveUI = async (uiSchema: any) => {
    setIsSaving(true);
    try {
      // For stream_subscription, use a minimal passthrough parser
      const effectiveParserCode = dataSource === 'stream_subscription'
        ? `# Auto-generated: This app subscribes to a data stream\n# No parser needed - data flows directly from the stream\ndef parse_payload(raw_data: dict) -> dict:\n    return raw_data\n\nSCHEMA = ${JSON.stringify(parsedSchema, null, 4)}`
        : parserCode;

      if (editMode && editingAppId) {
        await updateAppMutation.mutateAsync({
          appId: editingAppId,
          name: appName,
          description: appDescription || undefined,
          dataSource,
          dataSourceConfig: streamConfig || undefined,
          parserCode: effectiveParserCode,
          dataSchema: parsedSchema,
          uiSchema,
          createVersion: true,
        });
        toast.success(`App "${appName}" updated successfully!`);
      } else {
        await saveAppMutation.mutateAsync({
          name: appName,
          description: appDescription || undefined,
          dataSource,
          dataSourceConfig: streamConfig || undefined,
          parserCode: effectiveParserCode,
          dataSchema: parsedSchema,
          uiSchema,
        });
        toast.success(`App "${appName}" saved successfully!`);
      }
      clearSavedData();
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
        initialUiSchema={editMode && existingApp ? existingApp.uiSchema : undefined}
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

        {/* Data Source Selection */}
        <Card>
          <CardHeader>
            <CardTitle>Data Source</CardTitle>
            <CardDescription>Choose how your app receives data</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Custom Endpoint */}
              <button
                onClick={() => setDataSource("custom_endpoint")}
                className={`relative p-4 rounded-lg border-2 text-left transition-all ${
                  dataSource === "custom_endpoint"
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50"
                }`}
              >
                {dataSource === "custom_endpoint" && (
                  <div className="absolute top-2 right-2">
                    <Check className="h-4 w-4 text-primary" />
                  </div>
                )}
                <Code className="h-8 w-8 mb-3 text-blue-500" />
                <h3 className="font-semibold mb-1">Custom Endpoint</h3>
                <p className="text-sm text-muted-foreground">
                  Create your own REST endpoint with a Python parser to transform incoming data
                </p>
                <Badge variant="secondary" className="mt-2">Most Flexible</Badge>
              </button>

              {/* Stream Subscription */}
              <button
                onClick={() => setDataSource("stream_subscription")}
                className={`relative p-4 rounded-lg border-2 text-left transition-all ${
                  dataSource === "stream_subscription"
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50"
                }`}
              >
                {dataSource === "stream_subscription" && (
                  <div className="absolute top-2 right-2">
                    <Check className="h-4 w-4 text-primary" />
                  </div>
                )}
                <Radio className="h-8 w-8 mb-3 text-green-500" />
                <h3 className="font-semibold mb-1">Subscribe to Stream</h3>
                <p className="text-sm text-muted-foreground">
                  Tap into an existing data stream (RPLidar, Telemetry, Camera, or another app)
                </p>
                <Badge variant="secondary" className="mt-2">Easiest</Badge>
              </button>

              {/* Passthrough */}
              <button
                onClick={() => setDataSource("passthrough")}
                className={`relative p-4 rounded-lg border-2 text-left transition-all ${
                  dataSource === "passthrough"
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50"
                }`}
              >
                {dataSource === "passthrough" && (
                  <div className="absolute top-2 right-2">
                    <Check className="h-4 w-4 text-primary" />
                  </div>
                )}
                <Zap className="h-8 w-8 mb-3 text-yellow-500" />
                <h3 className="font-semibold mb-1">Passthrough</h3>
                <p className="text-sm text-muted-foreground">
                  Send raw JSON directly to widgets — no parser needed, just define the schema
                </p>
                <Badge variant="secondary" className="mt-2">Quick Setup</Badge>
              </button>
            </div>
          </CardContent>
        </Card>

        {/* Stream Subscription: Stream Picker */}
        {dataSource === "stream_subscription" && (
          <Card>
            <CardHeader>
              <CardTitle>Select Data Stream</CardTitle>
              <CardDescription>
                Choose an existing data stream to subscribe to. Your app will receive live data from this stream.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!availableStreams ? (
                <p className="text-muted-foreground">Loading available streams...</p>
              ) : availableStreams.length === 0 ? (
                <p className="text-muted-foreground">No streams available</p>
              ) : (
                <div className="space-y-3">
                  {availableStreams.map((stream) => (
                    <button
                      key={stream.id}
                      onClick={() => handleStreamSelect(stream.id)}
                      className={`w-full p-4 rounded-lg border-2 text-left transition-all ${
                        selectedStreamId === stream.id
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/50"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <h4 className="font-semibold">{stream.name}</h4>
                          <p className="text-sm text-muted-foreground">{stream.description}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-xs">
                            {Object.keys(stream.fields).length} fields
                          </Badge>
                          {selectedStreamId === stream.id && (
                            <Check className="h-5 w-5 text-primary" />
                          )}
                        </div>
                      </div>
                      {/* Show fields when selected */}
                      {selectedStreamId === stream.id && (
                        <div className="mt-3 pt-3 border-t border-border">
                          <p className="text-xs text-muted-foreground mb-2 font-medium">Available Fields:</p>
                          <div className="flex flex-wrap gap-2">
                            {Object.entries(stream.fields).map(([fieldPath, fieldInfo]) => (
                              <Badge key={fieldPath} variant="secondary" className="text-xs font-mono">
                                {fieldPath}
                                <span className="ml-1 text-muted-foreground">({fieldInfo.type})</span>
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {selectedStream && (
                <div className="mt-4 p-3 bg-muted/50 rounded-lg">
                  <div className="flex items-start gap-2">
                    <Info className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
                    <div className="text-sm">
                      <p className="font-medium">How it works</p>
                      <p className="text-muted-foreground mt-1">
                        Your app will automatically subscribe to the <strong>{selectedStream.name}</strong> WebSocket channel.
                        Data fields will be mapped to your UI widgets. No parser code needed.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Custom Endpoint: Parser Code */}
        {dataSource === "custom_endpoint" && (
          <>
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
                <Textarea
                  id="parserCode"
                  value={parserCode}
                  onChange={(e) => setParserCode(e.target.value)}
                  rows={20}
                  className="font-mono text-sm"
                />
              </CardContent>
            </Card>

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
          </>
        )}

        {/* Passthrough: Schema Definition */}
        {dataSource === "passthrough" && (
          <Card>
            <CardHeader>
              <CardTitle>Schema Definition</CardTitle>
              <CardDescription>
                Define the SCHEMA dictionary that describes your data fields. No parse_payload function needed — 
                raw JSON will be passed directly to widgets.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                value={parserCode}
                onChange={(e) => setParserCode(e.target.value)}
                rows={15}
                className="font-mono text-sm"
                placeholder={`# Just define the SCHEMA — no parser function needed
SCHEMA = {
    "temperature": {
        "type": "number",
        "unit": "°C",
        "description": "Temperature reading"
    },
    "status": {
        "type": "string",
        "description": "Device status"
    }
}`}
              />
              <div className="p-3 bg-muted/50 rounded-lg">
                <div className="flex items-start gap-2">
                  <Info className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
                  <div className="text-sm">
                    <p className="font-medium">Passthrough Endpoint</p>
                    <p className="text-muted-foreground mt-1">
                      Send JSON data to <code className="bg-muted px-1 rounded">POST /api/rest/payload/{'{'}<em>appId</em>{'}'}/ingest</code>.
                      The raw JSON fields will be mapped directly to your UI widgets.
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-4 pb-16">
          <Button variant="outline" onClick={onBack}>
            Cancel
          </Button>
          <Button onClick={handleContinueToUI}>
            <ChevronRight className="h-4 w-4 mr-2" />
            Continue to UI Builder
          </Button>
        </div>
      </div>
    </div>
  );
}
