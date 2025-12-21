# Parser Output Format Specification

## Overview

Custom payload parsers must return data in a standardized format that can be consumed by the UI Builder and REST endpoints. This document defines the required output structure.

## Output Structure

### Basic Format

```python
def parse_payload(raw_data: dict) -> dict:
    """
    Parse raw payload data into structured format.
    
    Returns:
        Dictionary with parsed fields matching the SCHEMA definition
    """
    return {
        "field_name": value,
        # ... more fields
    }
```

### Schema Definition

Every parser must define a `SCHEMA` that describes the output fields:

```python
SCHEMA = {
    "field_name": {
        "type": "number" | "string" | "boolean",
        "unit": "optional unit string (e.g., '°C', 'km/h', '%')",
        "description": "Human-readable description",
        "min": optional_minimum_value,  # for numbers
        "max": optional_maximum_value,  # for numbers
        "format": "optional format hint (e.g., 'iso8601', 'hex', 'base64')"
    }
}
```

## Field Types

### Number Fields
```python
{
    "temperature": {
        "type": "number",
        "unit": "°C",
        "description": "Ambient temperature",
        "min": -50,
        "max": 100
    }
}
```

### String Fields
```python
{
    "status": {
        "type": "string",
        "description": "Device status message",
        "format": "text"
    },
    "timestamp": {
        "type": "string",
        "description": "ISO 8601 timestamp",
        "format": "iso8601"
    }
}
```

### Boolean Fields
```python
{
    "is_active": {
        "type": "boolean",
        "description": "Whether device is active"
    }
}
```

## Complete Example

```python
def parse_payload(raw_data: dict) -> dict:
    """
    Parse weather station data.
    """
    return {
        "temperature": raw_data.get("temp_raw", 0) / 100.0,
        "humidity": raw_data.get("hum_raw", 0) / 100.0,
        "pressure": raw_data.get("press_raw", 0) / 10.0,
        "wind_speed": raw_data.get("wind_raw", 0) / 10.0,
        "timestamp": raw_data.get("ts", ""),
        "is_raining": raw_data.get("rain", 0) > 0,
        "location": raw_data.get("loc", "unknown")
    }

SCHEMA = {
    "temperature": {
        "type": "number",
        "unit": "°C",
        "description": "Ambient temperature",
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
    "pressure": {
        "type": "number",
        "unit": "hPa",
        "description": "Atmospheric pressure",
        "min": 900,
        "max": 1100
    },
    "wind_speed": {
        "type": "number",
        "unit": "km/h",
        "description": "Wind speed",
        "min": 0,
        "max": 200
    },
    "timestamp": {
        "type": "string",
        "description": "ISO 8601 timestamp",
        "format": "iso8601"
    },
    "is_raining": {
        "type": "boolean",
        "description": "Whether it is currently raining"
    },
    "location": {
        "type": "string",
        "description": "Weather station location identifier"
    }
}
```

## REST Endpoint Integration

When a custom app is created, the system will generate a REST endpoint:

```
POST /api/rest/payload/{app_id}/ingest
```

### Request Format
```json
{
  "drone_id": "string (required)",
  "api_key": "string (required)",
  "payload": {
    // Raw data matching your parser's expected input
  }
}
```

### Response Format
```json
{
  "success": true,
  "parsed_data": {
    // Parsed data matching your SCHEMA
  },
  "timestamp": "2025-12-21T06:00:00Z"
}
```

## UI Builder Integration

The UI Builder will use the SCHEMA to:

1. **Display available fields** - Show all fields that can be bound to widgets
2. **Validate data types** - Ensure widgets are compatible with field types
3. **Show units** - Display units in labels and tooltips
4. **Set ranges** - Use min/max for gauges and charts
5. **Format values** - Apply format hints for display

### Widget-Field Compatibility

| Widget Type | Compatible Field Types |
|------------|----------------------|
| Text Display | string, number, boolean |
| Line Chart | number |
| Gauge | number (with min/max) |
| LED Indicator | boolean |
| Map | string (lat/lon format) |
| Video Feed | string (URL format) |

## Validation Rules

1. **Required fields**: `parse_payload` function and `SCHEMA` definition
2. **Type consistency**: Output values must match SCHEMA types
3. **Field names**: Must be valid Python identifiers (alphanumeric + underscore)
4. **No reserved names**: Cannot use `_id`, `_timestamp`, `_drone_id` (system reserved)
5. **Schema completeness**: All output fields must be defined in SCHEMA

## Error Handling

Parsers should handle missing or invalid data gracefully:

```python
def parse_payload(raw_data: dict) -> dict:
    # Use .get() with defaults
    temp_raw = raw_data.get("temp_raw", 0)
    
    # Validate and clamp values
    temperature = max(-50, min(60, temp_raw / 100.0))
    
    # Handle missing timestamps
    timestamp = raw_data.get("ts", datetime.utcnow().isoformat())
    
    return {
        "temperature": temperature,
        "timestamp": timestamp
    }
```

## Best Practices

1. **Use descriptive field names** - `battery_voltage` instead of `bv`
2. **Include units in SCHEMA** - Makes UI generation easier
3. **Set realistic min/max** - Helps with visualization scaling
4. **Handle missing data** - Always provide defaults
5. **Document format hints** - Helps UI render data correctly
6. **Keep it simple** - Complex transformations should be in the parser, not the UI
