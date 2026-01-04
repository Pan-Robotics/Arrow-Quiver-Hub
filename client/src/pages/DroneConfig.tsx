import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Upload, FileText, Settings, History, Trash2 } from "lucide-react";

export default function DroneConfig() {
  const [selectedDrone, setSelectedDrone] = useState<string>("quiver_001");
  const [file, setFile] = useState<File | null>(null);
  const [targetPath, setTargetPath] = useState<string>("/home/pi/config/");
  const [description, setDescription] = useState<string>("");
  const [uploading, setUploading] = useState(false);

  const utils = trpc.useUtils();

  // Fetch drones
  const { data: dronesData } = trpc.drones.list.useQuery();
  const drones = dronesData?.drones || [];

  // Fetch jobs for selected drone
  const { data: jobsData } = trpc.droneJobs.getAllJobs.useQuery(
    { droneId: selectedDrone, limit: 20 },
    { enabled: !!selectedDrone }
  );
  const jobs = jobsData?.jobs || [];

  // Fetch files for selected drone
  const { data: filesData } = trpc.droneJobs.getFiles.useQuery(
    { droneId: selectedDrone },
    { enabled: !!selectedDrone }
  );
  const files = filesData?.files || [];

  // Upload file mutation
  const uploadFileMutation = trpc.droneJobs.uploadFile.useMutation({
    onSuccess: () => {
      toast.success("File uploaded successfully!");
      setFile(null);
      setDescription("");
      utils.droneJobs.getFiles.invalidate({ droneId: selectedDrone });
      utils.droneJobs.getAllJobs.invalidate({ droneId: selectedDrone });
    },
    onError: (error) => {
      toast.error(`Upload failed: ${error.message}`);
    },
  });

  // Delete file mutation
  const deleteFileMutation = trpc.droneJobs.deleteFile.useMutation({
    onSuccess: () => {
      toast.success("File deleted successfully!");
      utils.droneJobs.getFiles.invalidate({ droneId: selectedDrone });
    },
    onError: (error) => {
      toast.error(`Delete failed: ${error.message}`);
    },
  });

  // Handle file upload
  const handleUpload = async () => {
    if (!file) {
      toast.error("Please select a file");
      return;
    }

    if (!targetPath) {
      toast.error("Please specify target path");
      return;
    }

    setUploading(true);

    try {
      // Read file as base64
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string).split(",")[1];

        await uploadFileMutation.mutateAsync({
          droneId: selectedDrone,
          filename: file.name,
          content: base64,
          mimeType: file.type,
          description,
          targetPath: targetPath + file.name,
        });

        setUploading(false);
      };
      reader.onerror = () => {
        toast.error("Failed to read file");
        setUploading(false);
      };
      reader.readAsDataURL(file);
    } catch (error) {
      setUploading(false);
    }
  };

  // Format timestamp
  const formatTime = (date: Date | string) => {
    return new Date(date).toLocaleString();
  };

  // Get status badge color
  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "bg-green-500/10 text-green-500";
      case "failed":
        return "bg-red-500/10 text-red-500";
      case "in_progress":
        return "bg-blue-500/10 text-blue-500";
      default:
        return "bg-yellow-500/10 text-yellow-500";
    }
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Drone Configuration</h1>
            <p className="text-muted-foreground">
              Upload files and manage configuration for your drones
            </p>
          </div>
          <Select value={selectedDrone} onValueChange={setSelectedDrone}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Select drone" />
            </SelectTrigger>
            <SelectContent>
              {drones.map((drone: any) => (
                <SelectItem key={drone.droneId} value={drone.droneId}>
                  {drone.name || drone.droneId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* File Upload Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="w-5 h-5" />
              Upload File
            </CardTitle>
            <CardDescription>
              Upload parser files, configuration files, or any other files to the drone
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>File</Label>
              <Input
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                disabled={uploading}
              />
            </div>

            <div className="space-y-2">
              <Label>Target Path on Raspberry Pi</Label>
              <Input
                value={targetPath}
                onChange={(e) => setTargetPath(e.target.value)}
                placeholder="/home/pi/config/"
                disabled={uploading}
              />
              <p className="text-xs text-muted-foreground">
                Specify the directory where the file should be saved on the Pi
              </p>
            </div>

            <div className="space-y-2">
              <Label>Description (Optional)</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g., Updated parser for sensor data"
                disabled={uploading}
                rows={2}
              />
            </div>

            <Button
              onClick={handleUpload}
              disabled={!file || uploading}
              className="w-full"
            >
              {uploading ? "Uploading..." : "Upload File"}
            </Button>
          </CardContent>
        </Card>

        {/* Files List */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5" />
              Uploaded Files
            </CardTitle>
            <CardDescription>
              Files available for download by the drone
            </CardDescription>
          </CardHeader>
          <CardContent>
            {files.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No files uploaded yet
              </p>
            ) : (
              <div className="space-y-2">
                {files.map((file: any) => (
                  <div
                    key={file.id}
                    className="flex items-center justify-between p-3 border rounded-lg"
                  >
                    <div className="flex-1">
                      <p className="font-medium">{file.filename}</p>
                      <p className="text-xs text-muted-foreground">
                        {file.description || "No description"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Uploaded: {formatTime(file.createdAt)} • Size:{" "}
                        {(file.fileSize / 1024).toFixed(2)} KB
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteFileMutation.mutate({ fileId: file.fileId })}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Job History */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="w-5 h-5" />
              Job History
            </CardTitle>
            <CardDescription>
              Recent jobs sent to the drone
            </CardDescription>
          </CardHeader>
          <CardContent>
            {jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No jobs yet
              </p>
            ) : (
              <div className="space-y-2">
                {jobs.map((job: any) => (
                  <div
                    key={job.id}
                    className="flex items-start justify-between p-3 border rounded-lg"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{job.type}</p>
                        <span
                          className={`text-xs px-2 py-1 rounded-full ${getStatusColor(
                            job.status
                          )}`}
                        >
                          {job.status}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        Created: {formatTime(job.createdAt)}
                      </p>
                      {job.acknowledgedAt && (
                        <p className="text-xs text-muted-foreground">
                          Acknowledged: {formatTime(job.acknowledgedAt)}
                        </p>
                      )}
                      {job.completedAt && (
                        <p className="text-xs text-muted-foreground">
                          Completed: {formatTime(job.completedAt)}
                        </p>
                      )}
                      {job.errorMessage && (
                        <p className="text-xs text-red-500 mt-1">
                          Error: {job.errorMessage}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
