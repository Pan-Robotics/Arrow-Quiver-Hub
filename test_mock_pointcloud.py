#!/usr/bin/env python3
"""
Mock RPLidar data sender for testing the PointCloudCanvas visualization.

Generates realistic 2D LiDAR scan patterns and sends them to the server
via the REST API, simulating what the actual RPLidar forwarder would send.

Usage:
    python3 test_mock_pointcloud.py --url http://localhost:3000 --api-key <key>
"""

import requests
import math
import time
import random
import json
import sys
import argparse

def generate_mock_scan(scan_number=0):
    """
    Generate a realistic RPLidar scan with ~360 points.
    Simulates a room-like environment with walls and objects.
    """
    points = []
    num_points = 360

    for i in range(num_points):
        angle = (i * 360.0 / num_points)  # degrees
        angle_rad = math.radians(angle)

        # Simulate a room with walls
        # Base distance varies to create room shape
        if 0 <= angle < 90:
            # Front wall at ~3000mm with slight variation
            base_dist = 3000 + 200 * math.sin(angle_rad * 3)
        elif 90 <= angle < 180:
            # Right wall at ~2500mm
            base_dist = 2500 + 150 * math.cos(angle_rad * 2)
        elif 180 <= angle < 270:
            # Back wall at ~4000mm
            base_dist = 4000 + 300 * math.sin(angle_rad * 4)
        else:
            # Left wall at ~2000mm
            base_dist = 2000 + 100 * math.cos(angle_rad * 5)

        # Add some objects (furniture-like obstacles)
        # Object 1: at ~45 degrees, ~1500mm
        if 40 <= angle <= 55:
            base_dist = min(base_dist, 1500 + random.uniform(-50, 50))
        # Object 2: at ~150 degrees, ~1800mm
        if 145 <= angle <= 165:
            base_dist = min(base_dist, 1800 + random.uniform(-30, 30))
        # Object 3: at ~250 degrees, ~1200mm (closer object)
        if 245 <= angle <= 260:
            base_dist = min(base_dist, 1200 + random.uniform(-40, 40))

        # Add noise
        distance = max(100, base_dist + random.gauss(0, 20))

        # Add slight movement per scan to simulate rotation/drift
        distance += 50 * math.sin(scan_number * 0.1 + angle_rad)

        # Quality (0-47 for RPLidar, higher = better)
        quality = random.randint(10, 47)

        # Some points may be invalid (distance = 0)
        if random.random() < 0.02:  # 2% invalid points
            distance = 0
            quality = 0

        # Calculate x, y (same as the forwarder does)
        x = distance * math.cos(angle_rad)
        y = distance * math.sin(angle_rad)

        points.append({
            "angle": round(angle, 2),
            "distance": round(distance, 1),
            "quality": quality,
            "x": round(x, 1),
            "y": round(y, 1)
        })

    # Calculate stats
    valid_points = [p for p in points if p["distance"] > 0]
    distances = [p["distance"] for p in valid_points]
    qualities = [p["quality"] for p in valid_points]

    stats = {
        "point_count": len(points),
        "valid_points": len(valid_points),
        "min_distance": min(distances) if distances else 0,
        "max_distance": max(distances) if distances else 0,
        "avg_distance": sum(distances) / len(distances) if distances else 0,
        "avg_quality": sum(qualities) / len(qualities) if qualities else 0
    }

    return points, stats


def send_scan(url, api_key, drone_id, points, stats):
    """Send a scan to the server via REST API."""
    payload = {
        "api_key": api_key,
        "drone_id": drone_id,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "points": points,
        "stats": stats
    }

    try:
        response = requests.post(
            f"{url}/api/rest/pointcloud/ingest",
            json=payload,
            timeout=5
        )
        return response.status_code, response.json()
    except Exception as e:
        return 0, {"error": str(e)}


def main():
    parser = argparse.ArgumentParser(description="Mock RPLidar data sender")
    parser.add_argument("--url", default="http://localhost:3000", help="Server URL")
    parser.add_argument("--api-key", required=True, help="API key for authentication")
    parser.add_argument("--drone-id", default="quiver_001", help="Drone ID")
    parser.add_argument("--count", type=int, default=50, help="Number of scans to send")
    parser.add_argument("--interval", type=float, default=0.1, help="Interval between scans (seconds)")
    parser.add_argument("--single", action="store_true", help="Send a single scan and print details")
    args = parser.parse_args()

    print(f"Mock RPLidar Data Sender")
    print(f"Server: {args.url}")
    print(f"Drone ID: {args.drone_id}")
    print(f"Scans to send: {args.count}")
    print(f"Interval: {args.interval}s")
    print()

    if args.single:
        # Send a single scan and print the data for debugging
        points, stats = generate_mock_scan(0)
        print(f"Generated {len(points)} points")
        print(f"Stats: {json.dumps(stats, indent=2)}")
        print(f"\nSample points (first 5):")
        for p in points[:5]:
            print(f"  angle={p['angle']}°, dist={p['distance']}mm, quality={p['quality']}, x={p['x']}, y={p['y']}")

        status, result = send_scan(args.url, args.api_key, args.drone_id, points, stats)
        print(f"\nResponse: {status}")
        print(json.dumps(result, indent=2))
        return

    # Send multiple scans
    success_count = 0
    error_count = 0

    for i in range(args.count):
        points, stats = generate_mock_scan(i)
        status, result = send_scan(args.url, args.api_key, args.drone_id, points, stats)

        if status == 200:
            success_count += 1
            print(f"  Scan {i+1}/{args.count}: OK ({stats['valid_points']} valid points, "
                  f"avg_dist={stats['avg_distance']:.0f}mm)")
        else:
            error_count += 1
            print(f"  Scan {i+1}/{args.count}: ERROR {status} - {result}")

        if i < args.count - 1:
            time.sleep(args.interval)

    print(f"\nDone! Sent {success_count} scans, {error_count} errors")


if __name__ == "__main__":
    main()
