import UIBuilder from "./UIBuilder";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { ArrowLeft, Play, FileUp, Radio, Code, Zap, Check, ChevronRight, Info, ChevronDown, ChevronUp } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useRef, useState, useEffect, useMemo, useCallback } from "react";

interface AppBuilderProps {
  onBack: () => void;
  editMode?: boolean;
  editingAppId?: string;
}

type DataSourceType = "custom_endpoint" | "stream_subscription" | "passthrough";

/** Per-stream subscription config with selected fields */
interface StreamSubscription {
  streamId: string;
  streamEvent: string;
  subscribeEvent: string;
  subscribeParam: string;
  selectedFields: string[]; // field paths selected by the user
  fieldAliases: Record<string, string>; // streamField -> alias (for conflict resolution)
}

/** Legacy single-stream config for backward compatibility */
interface LegacyStreamConfig {
  streamId: string;
  streamEvent: string;
  subscribeEvent: string;
  subscribeParam: string;
  fieldMappings: Record<string, string>;
}

/** New multi-stream config */
interface MultiStreamConfig {
  streams: StreamSubscription[];
  fieldMappings: Record<string, string>; // combined: widgetField -> "streamId:fieldPath"
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
  const [streamSubscriptions, setStreamSubscriptions] = useState<StreamSubscription[]>(savedData?.streamSubscriptions || []);
  const [expandedStreams, setExpandedStreams] = useState<Set<string>>(new Set());
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
          // Handle both legacy single-stream and new multi-stream configs
          if (config?.streams && Array.isArray(config.streams)) {
            setStreamSubscriptions(config.streams);
          } else if (config?.streamId) {
            // Legacy single-stream: convert to multi-stream format
            const legacyFields = config.fieldMappings
              ? Object.values(config.fieldMappings) as string[]
              : [];
            setStreamSubscriptions([{
              streamId: config.streamId,
              streamEvent: config.streamEvent,
              subscribeEvent: config.subscribeEvent,
              subscribeParam: config.subscribeParam,
              selectedFields: legacyFields.length > 0 ? legacyFields : [],
              fieldAliases: {},
            }]);
          }
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
      streamSubscriptions,
      parserCode,
      testData,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(formData));
    } catch (error) {
      console.error('[AppBuilder] Failed to save form data:', error);
    }
  }, [appName, appDescription, dataSource, streamSubscriptions, parserCode, testData]);

  const clearSavedData = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.error('[AppBuilder] Failed to clear saved data:', error);
    }
  };

  const testParserMutation = trpc.appBuilder.testParser.useMutation();
  const extractSchemaMutation = trpc.appBuilder.extractSchema.useMutation();

  // Re-derive streamSubscriptions from localStorage when streams load
  useEffect(() => {
    if (dataSource === 'stream_subscription' && streamSubscriptions.length > 0 && availableStreams) {
      // Validate that saved subscriptions still reference valid streams
      const validSubs = streamSubscriptions.filter(sub =>
        availableStreams.some(s => s.id === sub.streamId)
      );
      if (validSubs.length !== streamSubscriptions.length) {
        setStreamSubscriptions(validSubs);
      }
    }
  }, [dataSource, availableStreams]);

  // Build combined schema from all stream subscriptions
  const buildCombinedSchema = useCallback((): { schema: Record<string, any>; fieldMappings: Record<string, string> } => {
    if (!availableStreams) return { schema: {}, fieldMappings: {} };

    const schema: Record<string, any> = {};
    const fieldMappings: Record<string, string> = {};
    const usedNames = new Set<string>();

    for (const sub of streamSubscriptions) {
      const stream = availableStreams.find(s => s.id === sub.streamId);
      if (!stream) continue;

      for (const fieldPath of sub.selectedFields) {
        const fieldInfo = stream.fields[fieldPath];
        if (!fieldInfo) continue;

        // Determine the widget field name
        const baseName = fieldPath.includes('.') ? fieldPath.split('.').pop()! : fieldPath;
        const alias = sub.fieldAliases[fieldPath];
        let widgetName = alias || baseName;

        // Handle conflicts: prefix with stream name if duplicate
        if (usedNames.has(widgetName) && !alias) {
          const streamPrefix = stream.id.replace(/[^a-zA-Z0-9]/g, '_');
          widgetName = `${streamPrefix}_${baseName}`;
        }
        usedNames.add(widgetName);

        schema[widgetName] = {
          type: fieldInfo.type,
          description: `${fieldInfo.description} (from ${stream.name})`,
        };
        fieldMappings[widgetName] = `${sub.streamId}:${fieldPath}`;
      }
    }

    return { schema, fieldMappings };
  }, [streamSubscriptions, availableStreams]);

  // Auto-update parsedSchema when stream subscriptions change
  useEffect(() => {
    if (dataSource === 'stream_subscription' && streamSubscriptions.length > 0) {
      const { schema } = buildCombinedSchema();
      if (Object.keys(schema).length > 0) {
        setParsedSchema(schema);
      }
    }
  }, [dataSource, streamSubscriptions, buildCombinedSchema]);

  // Toggle a stream's expanded state
  const toggleStreamExpanded = (streamId: string) => {
    setExpandedStreams(prev => {
      const next = new Set(prev);
      if (next.has(streamId)) {
        next.delete(streamId);
      } else {
        next.add(streamId);
      }
      return next;
    });
  };

  // Toggle a stream subscription (add/remove entire stream)
  const toggleStreamSubscription = (streamId: string) => {
    const stream = availableStreams?.find(s => s.id === streamId);
    if (!stream) return;

    setStreamSubscriptions(prev => {
      const existing = prev.find(s => s.streamId === streamId);
      if (existing) {
        // Remove this stream
        return prev.filter(s => s.streamId !== streamId);
      } else {
        // Add with all fields selected by default
        const allFields = Object.keys(stream.fields);
        return [...prev, {
          streamId: stream.id,
          streamEvent: stream.event,
          subscribeEvent: stream.subscribeEvent,
          subscribeParam: stream.subscribeParam,
          selectedFields: allFields,
          fieldAliases: {},
        }];
      }
    });
    // Auto-expand when adding
    setExpandedStreams(prev => {
      const next = new Set(prev);
      next.add(streamId);
      return next;
    });
  };

  // Toggle a single field within a stream subscription
  const toggleField = (streamId: string, fieldPath: string) => {
    setStreamSubscriptions(prev => {
      return prev.map(sub => {
        if (sub.streamId !== streamId) return sub;
        const hasField = sub.selectedFields.includes(fieldPath);
        return {
          ...sub,
          selectedFields: hasField
            ? sub.selectedFields.filter(f => f !== fieldPath)
            : [...sub.selectedFields, fieldPath],
        };
      });
    });
  };

  // Select all / deselect all fields for a stream
  const toggleAllFields = (streamId: string, selectAll: boolean) => {
    const stream = availableStreams?.find(s => s.id === streamId);
    if (!stream) return;

    setStreamSubscriptions(prev => {
      return prev.map(sub => {
        if (sub.streamId !== streamId) return sub;
        return {
          ...sub,
          selectedFields: selectAll ? Object.keys(stream.fields) : [],
        };
      });
    });
  };

  // Count total selected fields across all streams
  const totalSelectedFields = useMemo(() => {
    return streamSubscriptions.reduce((sum, sub) => sum + sub.selectedFields.length, 0);
  }, [streamSubscriptions]);

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

    // For stream_subscription, schema is built from selected fields
    if (dataSource === 'stream_subscription') {
      if (streamSubscriptions.length === 0) {
        toast.error("Please select at least one data stream");
        return;
      }
      if (totalSelectedFields === 0) {
        toast.error("Please select at least one data field from your streams");
        return;
      }
      const { schema } = buildCombinedSchema();
      setParsedSchema(schema);
      setShowUIBuilder(true);
      const streamCount = streamSubscriptions.length;
      toast.success(`${streamCount} stream${streamCount > 1 ? 's' : ''} configured with ${totalSelectedFields} fields! Now design your UI`);
      return;
    }

    // For passthrough, we need the user to define a manual schema
    if (dataSource === 'passthrough') {
      if (!parserCode.trim()) {
        toast.error("Please define a SCHEMA in the code editor (no parse_payload function needed)");
        return;
      }
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
      const { fieldMappings } = buildCombinedSchema();

      // Build the multi-stream config
      const multiStreamConfig: MultiStreamConfig = {
        streams: streamSubscriptions,
        fieldMappings,
      };

      // For stream_subscription, use a minimal passthrough parser
      const effectiveParserCode = dataSource === 'stream_subscription'
        ? `# Auto-generated: This app subscribes to ${streamSubscriptions.length} data stream(s)\n# No parser needed - data flows directly from the streams\ndef parse_payload(raw_data: dict) -> dict:\n    return raw_data\n\nSCHEMA = ${JSON.stringify(parsedSchema, null, 4)}`
        : parserCode;

      if (editMode && editingAppId) {
        await updateAppMutation.mutateAsync({
          appId: editingAppId,
          name: appName,
          description: appDescription || undefined,
          dataSource,
          dataSourceConfig: dataSource === 'stream_subscription' ? multiStreamConfig : undefined,
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
          dataSourceConfig: dataSource === 'stream_subscription' ? multiStreamConfig : undefined,
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
                <h3 className="font-semibold mb-1">Subscribe to Streams</h3>
                <p className="text-sm text-muted-foreground">
                  Mix and match data fields from multiple pipelines (RPLidar, Telemetry, Camera, custom apps)
                </p>
                <Badge variant="secondary" className="mt-2">Most Powerful</Badge>
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

        {/* Stream Subscription: Multi-Stream Picker with Per-Field Selection */}
        {dataSource === "stream_subscription" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Select Data Streams & Fields</span>
                {totalSelectedFields > 0 && (
                  <Badge variant="default" className="text-xs">
                    {streamSubscriptions.length} stream{streamSubscriptions.length !== 1 ? 's' : ''} · {totalSelectedFields} field{totalSelectedFields !== 1 ? 's' : ''}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                Select one or more data streams, then choose which fields to include in your app.
                Fields from different streams are merged into a single data object for your widgets.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!availableStreams ? (
                <p className="text-muted-foreground">Loading available streams...</p>
              ) : availableStreams.length === 0 ? (
                <p className="text-muted-foreground">No streams available</p>
              ) : (
                <div className="space-y-3">
                  {availableStreams.map((stream) => {
                    const isSubscribed = streamSubscriptions.some(s => s.streamId === stream.id);
                    const sub = streamSubscriptions.find(s => s.streamId === stream.id);
                    const isExpanded = expandedStreams.has(stream.id);
                    const allFields = Object.keys(stream.fields);
                    const selectedCount = sub?.selectedFields.length || 0;

                    return (
                      <div
                        key={stream.id}
                        className={`rounded-lg border-2 transition-all ${
                          isSubscribed
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/30"
                        }`}
                      >
                        {/* Stream Header */}
                        <div className="p-4 flex items-center gap-3">
                          <Checkbox
                            checked={isSubscribed}
                            onCheckedChange={() => toggleStreamSubscription(stream.id)}
                            className="h-5 w-5"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <h4 className="font-semibold">{stream.name}</h4>
                              <Badge variant="outline" className="text-xs shrink-0">
                                {allFields.length} fields
                              </Badge>
                              {isSubscribed && selectedCount > 0 && (
                                <Badge variant="default" className="text-xs shrink-0">
                                  {selectedCount} selected
                                </Badge>
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground truncate">{stream.description}</p>
                          </div>
                          {isSubscribed && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleStreamExpanded(stream.id);
                              }}
                              className="shrink-0"
                            >
                              {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            </Button>
                          )}
                        </div>

                        {/* Field Selection (expanded) */}
                        {isSubscribed && isExpanded && (
                          <div className="px-4 pb-4 border-t border-border/50 pt-3">
                            <div className="flex items-center justify-between mb-3">
                              <p className="text-xs text-muted-foreground font-medium">Select individual fields:</p>
                              <div className="flex gap-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 text-xs px-2"
                                  onClick={() => toggleAllFields(stream.id, true)}
                                >
                                  Select All
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 text-xs px-2"
                                  onClick={() => toggleAllFields(stream.id, false)}
                                >
                                  Deselect All
                                </Button>
                              </div>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              {Object.entries(stream.fields).map(([fieldPath, fieldInfo]) => {
                                const isSelected = sub?.selectedFields.includes(fieldPath) || false;
                                return (
                                  <label
                                    key={fieldPath}
                                    className={`flex items-center gap-2 p-2 rounded-md cursor-pointer transition-colors ${
                                      isSelected
                                        ? "bg-primary/10 border border-primary/30"
                                        : "bg-muted/30 border border-transparent hover:bg-muted/50"
                                    }`}
                                  >
                                    <Checkbox
                                      checked={isSelected}
                                      onCheckedChange={() => toggleField(stream.id, fieldPath)}
                                      className="h-4 w-4"
                                    />
                                    <div className="min-w-0 flex-1">
                                      <span className="text-sm font-mono block truncate">{fieldPath}</span>
                                      <span className="text-xs text-muted-foreground block truncate">
                                        {fieldInfo.type} — {fieldInfo.description}
                                      </span>
                                    </div>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Combined fields summary */}
              {totalSelectedFields > 0 && (
                <div className="mt-4 p-3 bg-muted/50 rounded-lg">
                  <div className="flex items-start gap-2">
                    <Info className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
                    <div className="text-sm">
                      <p className="font-medium">Combined Data Fields</p>
                      <p className="text-muted-foreground mt-1 mb-2">
                        Your app will receive a merged data object with {totalSelectedFields} fields from {streamSubscriptions.length} stream{streamSubscriptions.length !== 1 ? 's' : ''}.
                        These fields will be available for binding to UI widgets.
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {(() => {
                          const { schema } = buildCombinedSchema();
                          return Object.entries(schema).map(([name, info]: [string, any]) => (
                            <Badge key={name} variant="secondary" className="text-xs font-mono">
                              {name}
                              <span className="ml-1 text-muted-foreground">({info.type})</span>
                            </Badge>
                          ));
                        })()}
                      </div>
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
