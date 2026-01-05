# Raspberry Pi Client Update Instructions

## Issue Fixed

The `completeJob` API was returning **400 Bad Request** when the Raspberry Pi client tried to mark a job as completed. This was caused by the server not accepting `null` values for the optional `errorMessage` parameter.

## Changes Made

### Server-Side
1. Updated `completeJob` tRPC procedure to accept `null` for `errorMessage`:
   ```typescript
   errorMessage: z.string().nullable().optional()
   ```

2. Updated `completeJob` database function signature:
   ```typescript
   export async function completeJob(jobId: number, success: boolean, errorMessage?: string | null)
   ```

### Client-Side
Updated the Python client to conditionally include `errorMessage` only when it's not `None`:
```python
json_data = {
    'jobId': job_id,
    'apiKey': self.api_key,
    'droneId': self.drone_id,
    'success': success
}
# Only include errorMessage if it's not None
if error_message is not None:
    json_data['errorMessage'] = error_message

payload = {'json': json_data}
```

## Deployment Steps

### 1. Update the Python Client on Raspberry Pi

Copy the updated `raspberry_pi_client.py` file to your Raspberry Pi:

```bash
# On your development machine (where you have the updated file)
scp docs/raspberry_pi/raspberry_pi_client.py alexd@raspberrypi:~/raspberry_pi/

# Or if you're already on the Pi, download it directly
cd ~/raspberry_pi
wget https://YOUR_SERVER_URL/path/to/raspberry_pi_client.py
```

### 2. Restart the Quiver Hub Client Service

```bash
sudo systemctl restart quiver-hub-client
```

### 3. Monitor the Logs

```bash
sudo journalctl -u quiver-hub-client -f
```

You should now see successful job completions:
```
INFO - Found 1 pending job(s)
INFO - Processing job 1: upload_file
INFO - Acknowledged job 1
INFO - Downloading file 'test_config.yaml' to /home/alexd/config/test_config.yaml
INFO - Saved file to: /home/alexd/config/test_config.yaml
INFO - Completed job 1 successfully
```

### 4. Verify in Web UI

Go to the Drone Configuration page in the web UI and check:
- **Job History** should show the job status as "completed" (green checkmark)
- **Uploaded Files** should list the file with download/delete options

## Testing

To test the complete workflow:

1. **Upload a new file** through the web UI (Drone Configuration page)
2. **Watch the Pi logs** to see it poll, acknowledge, download, and complete the job
3. **Check the web UI** to verify the job status updates to "completed"
4. **Verify the file** exists on the Pi at the specified target path

## Troubleshooting

If you still see errors:

1. **Check API key**: Ensure the API key in your service configuration matches the one in the database
2. **Check server URL**: Verify the server URL is correct and accessible from the Pi
3. **Check file permissions**: Ensure the target directory is writable by the user running the service
4. **Check logs**: Look for detailed error messages in `journalctl -u quiver-hub-client -f`

## Next Steps

Once this is working:
- Test uploading parser files (`.py` scripts)
- Test uploading configuration files (`.yaml`, `.json`)
- Test the `update_config` job type
- Implement automatic parser execution on file upload
