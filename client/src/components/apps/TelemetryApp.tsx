import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  Activity, 
  Battery, 
  Navigation, 
  MapPin, 
  Satellite,
  Gauge,
  Zap,
  Thermometer,
  Plane
} from 'lucide-react';
import { io, Socket } from 'socket.io-client';

interface TelemetryData {
  attitude: {
    roll_deg: number;
    pitch_deg: number;
    yaw_deg: number;
    timestamp: string;
  } | null;
  position: {
    latitude_deg: number;
    longitude_deg: number;
    absolute_altitude_m: number;
    relative_altitude_m: number;
    timestamp: string;
  } | null;
  gps: {
    num_satellites: number;
    fix_type: number;
    timestamp: string;
  } | null;
  battery_fc: {
    voltage_v: number;
    remaining_percent: number;
    timestamp: string;
  } | null;
  battery_uavcan: {
    battery_id: number;
    voltage_v: number;
    current_a: number;
    temperature_k: number;
    state_of_charge_pct: number;
    timestamp: string;
  } | null;
  in_air: boolean;
}

interface TelemetryAppProps {
  droneId: string;
}

export default function TelemetryApp({ droneId }: TelemetryAppProps) {
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    // Connect to WebSocket
    const newSocket = io({
      path: '/socket.io/',
      transports: ['websocket', 'polling'],
    });

    newSocket.on('connect', () => {
      console.log('[Telemetry] WebSocket connected');
      setConnected(true);
      newSocket.emit('subscribe', droneId);
    });

    newSocket.on('disconnect', () => {
      console.log('[Telemetry] WebSocket disconnected');
      setConnected(false);
    });

    newSocket.on('telemetry', (data: { drone_id: string; timestamp: string; telemetry: TelemetryData }) => {
      if (data.drone_id === droneId) {
        setTelemetry(data.telemetry);
        setLastUpdate(new Date());
      }
    });

    setSocket(newSocket);

    return () => {
      newSocket.emit('unsubscribe', droneId);
      newSocket.disconnect();
    };
  }, [droneId]);

  const formatTimestamp = (timestamp: string | null) => {
    if (!timestamp) return 'N/A';
    return new Date(timestamp).toLocaleTimeString();
  };

  const getGPSFixType = (fixType: number) => {
    const types = ['No Fix', '2D Fix', '3D Fix', 'DGPS', 'RTK Float', 'RTK Fixed'];
    return types[fixType] || 'Unknown';
  };

  const getBatteryColor = (percent: number) => {
    if (percent > 60) return 'text-green-500';
    if (percent > 30) return 'text-yellow-500';
    return 'text-red-500';
  };

  return (
    <div className="h-full w-full overflow-auto bg-background">
      <div className="container py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Flight Telemetry</h1>
            <p className="text-muted-foreground">Real-time flight controller and battery data</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={connected ? 'default' : 'secondary'}>
              {connected ? '● Connected' : '○ Disconnected'}
            </Badge>
            {lastUpdate && (
              <span className="text-sm text-muted-foreground">
                Last update: {lastUpdate.toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>

        {!connected && (
          <Alert>
            <Activity className="h-4 w-4" />
            <AlertDescription>
              Waiting for telemetry data from drone <strong>{droneId}</strong>...
            </AlertDescription>
          </Alert>
        )}

        {/* Flight Status */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plane className="h-5 w-5" />
              Flight Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <Badge variant={telemetry?.in_air ? 'default' : 'secondary'} className="text-lg px-4 py-2">
                {telemetry?.in_air ? '✈️ In Air' : '🛬 On Ground'}
              </Badge>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Attitude */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Navigation className="h-5 w-5" />
                Attitude
              </CardTitle>
              <CardDescription>Roll, Pitch, Yaw (degrees)</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {telemetry?.attitude ? (
                <>
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium">Roll</span>
                      <span className="text-2xl font-bold">{telemetry.attitude.roll_deg.toFixed(1)}°</span>
                    </div>
                    <div className="w-full bg-secondary h-2 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-blue-500 transition-all"
                        style={{ 
                          width: `${Math.min(100, Math.abs(telemetry.attitude.roll_deg) / 90 * 100)}%`,
                          marginLeft: telemetry.attitude.roll_deg < 0 ? '0' : 'auto',
                          marginRight: telemetry.attitude.roll_deg > 0 ? '0' : 'auto'
                        }}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium">Pitch</span>
                      <span className="text-2xl font-bold">{telemetry.attitude.pitch_deg.toFixed(1)}°</span>
                    </div>
                    <div className="w-full bg-secondary h-2 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-green-500 transition-all"
                        style={{ 
                          width: `${Math.min(100, Math.abs(telemetry.attitude.pitch_deg) / 90 * 100)}%`,
                          marginLeft: telemetry.attitude.pitch_deg < 0 ? '0' : 'auto',
                          marginRight: telemetry.attitude.pitch_deg > 0 ? '0' : 'auto'
                        }}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium">Yaw</span>
                      <span className="text-2xl font-bold">{telemetry.attitude.yaw_deg.toFixed(1)}°</span>
                    </div>
                    <div className="w-full bg-secondary h-2 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-purple-500 transition-all"
                        style={{ width: `${(telemetry.attitude.yaw_deg / 360) * 100}%` }}
                      />
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Updated: {formatTimestamp(telemetry.attitude.timestamp)}
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground">No attitude data</p>
              )}
            </CardContent>
          </Card>

          {/* Position */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="h-5 w-5" />
                Position
              </CardTitle>
              <CardDescription>GPS coordinates and altitude</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {telemetry?.position ? (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Latitude</p>
                      <p className="text-lg font-mono">{telemetry.position.latitude_deg.toFixed(6)}°</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Longitude</p>
                      <p className="text-lg font-mono">{telemetry.position.longitude_deg.toFixed(6)}°</p>
                    </div>
                  </div>

                  <Separator />

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Altitude (AGL)</p>
                      <p className="text-2xl font-bold">{telemetry.position.relative_altitude_m.toFixed(1)} m</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Altitude (MSL)</p>
                      <p className="text-2xl font-bold">{telemetry.position.absolute_altitude_m.toFixed(1)} m</p>
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Updated: {formatTimestamp(telemetry.position.timestamp)}
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground">No position data</p>
              )}
            </CardContent>
          </Card>

          {/* GPS */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Satellite className="h-5 w-5" />
                GPS
              </CardTitle>
              <CardDescription>Satellite information</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {telemetry?.gps ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Satellites</span>
                    <span className="text-3xl font-bold">{telemetry.gps.num_satellites}</span>
                  </div>

                  <Separator />

                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Fix Type</span>
                    <Badge variant={telemetry.gps.fix_type >= 3 ? 'default' : 'secondary'}>
                      {getGPSFixType(telemetry.gps.fix_type)}
                    </Badge>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Updated: {formatTimestamp(telemetry.gps.timestamp)}
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground">No GPS data</p>
              )}
            </CardContent>
          </Card>

          {/* Battery (Flight Controller) */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Battery className="h-5 w-5" />
                Battery (Flight Controller)
              </CardTitle>
              <CardDescription>From MAVLink telemetry</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {telemetry?.battery_fc ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Charge</span>
                    <span className={`text-3xl font-bold ${getBatteryColor(telemetry.battery_fc.remaining_percent)}`}>
                      {telemetry.battery_fc.remaining_percent.toFixed(0)}%
                    </span>
                  </div>

                  <div className="w-full bg-secondary h-4 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all ${
                        telemetry.battery_fc.remaining_percent > 60 ? 'bg-green-500' :
                        telemetry.battery_fc.remaining_percent > 30 ? 'bg-yellow-500' : 'bg-red-500'
                      }`}
                      style={{ width: `${telemetry.battery_fc.remaining_percent}%` }}
                    />
                  </div>

                  <Separator />

                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Voltage</span>
                    <span className="text-2xl font-bold">{telemetry.battery_fc.voltage_v.toFixed(2)} V</span>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Updated: {formatTimestamp(telemetry.battery_fc.timestamp)}
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground">No battery data</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Battery (UAVCAN) - Full width if available */}
        {telemetry?.battery_uavcan && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5" />
                Battery (UAVCAN)
              </CardTitle>
              <CardDescription>From Tattu BMS via UAVCAN</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <div>
                  <p className="text-sm text-muted-foreground mb-2">State of Charge</p>
                  <p className={`text-3xl font-bold ${getBatteryColor(telemetry.battery_uavcan.state_of_charge_pct)}`}>
                    {telemetry.battery_uavcan.state_of_charge_pct}%
                  </p>
                  <div className="w-full bg-secondary h-2 rounded-full overflow-hidden mt-2">
                    <div 
                      className={`h-full transition-all ${
                        telemetry.battery_uavcan.state_of_charge_pct > 60 ? 'bg-green-500' :
                        telemetry.battery_uavcan.state_of_charge_pct > 30 ? 'bg-yellow-500' : 'bg-red-500'
                      }`}
                      style={{ width: `${telemetry.battery_uavcan.state_of_charge_pct}%` }}
                    />
                  </div>
                </div>

                <div>
                  <p className="text-sm text-muted-foreground mb-2">Voltage</p>
                  <p className="text-3xl font-bold">{telemetry.battery_uavcan.voltage_v.toFixed(2)}</p>
                  <p className="text-sm text-muted-foreground">Volts</p>
                </div>

                <div>
                  <p className="text-sm text-muted-foreground mb-2">Current</p>
                  <p className="text-3xl font-bold">{telemetry.battery_uavcan.current_a.toFixed(2)}</p>
                  <p className="text-sm text-muted-foreground">Amps</p>
                </div>

                <div>
                  <p className="text-sm text-muted-foreground mb-2 flex items-center gap-1">
                    <Thermometer className="h-4 w-4" />
                    Temperature
                  </p>
                  <p className="text-3xl font-bold">{(telemetry.battery_uavcan.temperature_k - 273.15).toFixed(1)}</p>
                  <p className="text-sm text-muted-foreground">°C</p>
                </div>
              </div>

              <p className="text-xs text-muted-foreground mt-4">
                Battery ID: {telemetry.battery_uavcan.battery_id} | 
                Updated: {formatTimestamp(telemetry.battery_uavcan.timestamp)}
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
