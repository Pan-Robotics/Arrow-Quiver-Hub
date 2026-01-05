#!/usr/bin/env python3
"""
Quiver Hub - Raspberry Pi Client
Two-way communication client for Raspberry Pi companion computer

This script runs on the Raspberry Pi and:
1. Polls the Quiver Hub server for pending jobs
2. Executes jobs (download files, update config, etc.)
3. Reports job completion status back to the server

Usage:
    python3 raspberry_pi_client.py --server https://your-server.com --drone-id quiver_001 --api-key your-api-key
"""

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urljoin

import requests

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class QuiverHubClient:
    """Client for communicating with Quiver Hub server"""
    
    def __init__(self, server_url: str, drone_id: str, api_key: str, poll_interval: int = 5):
        """
        Initialize the Quiver Hub client
        
        Args:
            server_url: Base URL of the Quiver Hub server (e.g., https://your-server.com)
            drone_id: Unique identifier for this drone (e.g., quiver_001)
            api_key: API key for authentication
            poll_interval: How often to poll for jobs in seconds (default: 5)
        """
        self.server_url = server_url.rstrip('/')
        self.drone_id = drone_id
        self.api_key = api_key
        self.poll_interval = poll_interval
        self.session = requests.Session()
        
        logger.info(f"Initialized Quiver Hub client for drone: {drone_id}")
        logger.info(f"Server: {server_url}")
        logger.info(f"Poll interval: {poll_interval}s")
    
    def get_pending_jobs(self) -> List[Dict]:
        """
        Fetch pending jobs from the server
        
        Returns:
            List of pending job dictionaries
        """
        try:
            url = urljoin(self.server_url, '/api/trpc/droneJobs.getPendingJobs')
            params = {
                'input': json.dumps({
                    'json': {
                        'droneId': self.drone_id,
                        'apiKey': self.api_key
                    }
                })
            }
            
            response = self.session.get(url, params=params, timeout=10)
            response.raise_for_status()
            
            data = response.json()
            jobs = data.get('result', {}).get('data', {}).get('json', {}).get('jobs', [])
            
            if jobs:
                logger.info(f"Found {len(jobs)} pending job(s)")
            
            return jobs
            
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to fetch pending jobs: {e}")
            return []
    
    def acknowledge_job(self, job_id: int) -> bool:
        """
        Acknowledge a job (mark as in progress)
        
        Args:
            job_id: ID of the job to acknowledge
            
        Returns:
            True if successful, False otherwise
        """
        try:
            url = urljoin(self.server_url, '/api/trpc/droneJobs.acknowledgeJob')
            payload = {
                'json': {
                    'jobId': job_id,
                    'apiKey': self.api_key,
                    'droneId': self.drone_id
                }
            }
            
            response = self.session.post(url, json=payload, timeout=10)
            response.raise_for_status()
            
            logger.info(f"Acknowledged job {job_id}")
            return True
            
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to acknowledge job {job_id}: {e}")
            return False
    
    def complete_job(self, job_id: int, success: bool, error_message: Optional[str] = None) -> bool:
        """
        Mark a job as completed
        
        Args:
            job_id: ID of the job
            success: Whether the job completed successfully
            error_message: Optional error message if job failed
            
        Returns:
            True if successful, False otherwise
        """
        try:
            url = urljoin(self.server_url, '/api/trpc/droneJobs.completeJob')
            payload = {
                'json': {
                    'jobId': job_id,
                    'apiKey': self.api_key,
                    'droneId': self.drone_id,
                    'success': success,
                    'errorMessage': error_message
                }
            }
            
            response = self.session.post(url, json=payload, timeout=10)
            response.raise_for_status()
            
            status = "successfully" if success else "with failure"
            logger.info(f"Completed job {job_id} {status}")
            return True
            
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to complete job {job_id}: {e}")
            return False
    
    def download_file(self, file_id: str, target_path: str) -> bool:
        """
        Download a file from the server
        
        Args:
            file_id: ID of the file to download
            target_path: Where to save the file on the Pi
            
        Returns:
            True if successful, False otherwise
        """
        try:
            # Get file metadata and download URL
            url = urljoin(self.server_url, '/api/trpc/droneJobs.getFile')
            params = {
                'input': json.dumps({
                    'json': {
                        'fileId': file_id,
                        'apiKey': self.api_key,
                        'droneId': self.drone_id
                    }
                })
            }
            
            response = self.session.get(url, params=params, timeout=10)
            response.raise_for_status()
            
            data = response.json()
            file_info = data.get('result', {}).get('data', {}).get('json', {}).get('file', {})
            file_url = file_info.get('url')
            
            if not file_url:
                raise ValueError("No download URL in response")
            
            # Download the file
            logger.info(f"Downloading file from: {file_url}")
            file_response = self.session.get(file_url, timeout=30)
            file_response.raise_for_status()
            
            # Ensure target directory exists
            target_dir = os.path.dirname(target_path)
            if target_dir:
                os.makedirs(target_dir, exist_ok=True)
            
            # Save the file
            with open(target_path, 'wb') as f:
                f.write(file_response.content)
            
            logger.info(f"Saved file to: {target_path}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to download file {file_id}: {e}")
            return False
    
    def handle_upload_file_job(self, job: Dict) -> tuple[bool, Optional[str]]:
        """
        Handle an upload_file job
        
        Args:
            job: Job dictionary
            
        Returns:
            Tuple of (success, error_message)
        """
        try:
            payload = job.get('payload', {})
            file_id = payload.get('fileId')
            target_path = payload.get('targetPath')
            filename = payload.get('filename')
            
            if not file_id or not target_path:
                return False, "Missing fileId or targetPath in job payload"
            
            logger.info(f"Downloading file '{filename}' to {target_path}")
            
            success = self.download_file(file_id, target_path)
            
            if success:
                return True, None
            else:
                return False, "File download failed"
                
        except Exception as e:
            logger.error(f"Error handling upload_file job: {e}")
            return False, str(e)
    
    def handle_update_config_job(self, job: Dict) -> tuple[bool, Optional[str]]:
        """
        Handle an update_config job
        
        Args:
            job: Job dictionary
            
        Returns:
            Tuple of (success, error_message)
        """
        try:
            payload = job.get('payload', {})
            config_data = payload.get('config', {})
            config_file = payload.get('configFile', '/home/alexd/config/quiver_config.json')
            
            logger.info(f"Updating config file: {config_file}")
            
            # Ensure directory exists
            config_dir = os.path.dirname(config_file)
            if config_dir:
                os.makedirs(config_dir, exist_ok=True)
            
            # Write config
            with open(config_file, 'w') as f:
                json.dump(config_data, f, indent=2)
            
            logger.info("Config updated successfully")
            return True, None
            
        except Exception as e:
            logger.error(f"Error handling update_config job: {e}")
            return False, str(e)
    
    def process_job(self, job: Dict):
        """
        Process a single job
        
        Args:
            job: Job dictionary from the server
        """
        job_id = job.get('id')
        job_type = job.get('type')
        
        logger.info(f"Processing job {job_id}: {job_type}")
        
        # Acknowledge the job
        if not self.acknowledge_job(job_id):
            logger.error(f"Failed to acknowledge job {job_id}, skipping")
            return
        
        # Execute the job based on type
        success = False
        error_message = None
        
        try:
            if job_type == 'upload_file':
                success, error_message = self.handle_upload_file_job(job)
            elif job_type == 'update_config':
                success, error_message = self.handle_update_config_job(job)
            else:
                error_message = f"Unknown job type: {job_type}"
                logger.warning(error_message)
        
        except Exception as e:
            error_message = f"Unexpected error: {str(e)}"
            logger.error(error_message)
        
        # Report completion
        self.complete_job(job_id, success, error_message)
    
    def run(self):
        """
        Main loop: poll for jobs and process them
        """
        logger.info("Starting Quiver Hub client...")
        logger.info("Press Ctrl+C to stop")
        
        try:
            while True:
                # Fetch pending jobs
                jobs = self.get_pending_jobs()
                
                # Process each job
                for job in jobs:
                    self.process_job(job)
                
                # Wait before next poll
                time.sleep(self.poll_interval)
                
        except KeyboardInterrupt:
            logger.info("Shutting down...")
        except Exception as e:
            logger.error(f"Fatal error: {e}")
            sys.exit(1)


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description='Quiver Hub Raspberry Pi Client',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Run with default settings
  python3 raspberry_pi_client.py --server https://your-server.com --drone-id quiver_001 --api-key abc123
  
  # Run with custom poll interval
  python3 raspberry_pi_client.py --server https://your-server.com --drone-id quiver_001 --api-key abc123 --poll-interval 10
        '''
    )
    
    parser.add_argument(
        '--server',
        required=True,
        help='Quiver Hub server URL (e.g., https://your-server.com)'
    )
    
    parser.add_argument(
        '--drone-id',
        required=True,
        help='Unique identifier for this drone (e.g., quiver_001)'
    )
    
    parser.add_argument(
        '--api-key',
        required=True,
        help='API key for authentication'
    )
    
    parser.add_argument(
        '--poll-interval',
        type=int,
        default=5,
        help='How often to poll for jobs in seconds (default: 5)'
    )
    
    parser.add_argument(
        '--debug',
        action='store_true',
        help='Enable debug logging'
    )
    
    args = parser.parse_args()
    
    # Set log level
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
    
    # Create and run client
    client = QuiverHubClient(
        server_url=args.server,
        drone_id=args.drone_id,
        api_key=args.api_key,
        poll_interval=args.poll_interval
    )
    
    client.run()


if __name__ == '__main__':
    main()
