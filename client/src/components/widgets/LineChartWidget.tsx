import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

interface LineChartWidgetProps {
  data: number[] | string;
  label?: string;
  color?: string;
  showGrid?: boolean;
  showLegend?: boolean;
  height?: number;
}

export default function LineChartWidget({
  data,
  label = 'Value',
  color = '#8884d8',
  showGrid = true,
  showLegend = true,
  height = 300,
}: LineChartWidgetProps) {
  // Parse data if it's a string
  const parsedData = typeof data === 'string' ? JSON.parse(data) : data;

  // Convert array of numbers to chart data format
  const chartData = Array.isArray(parsedData)
    ? parsedData.map((value, index) => ({
        index: index,
        value: typeof value === 'number' ? value : 0,
      }))
    : [];

  if (chartData.length === 0) {
    return (
      <div className="w-full flex items-center justify-center bg-muted rounded-lg" style={{ height }}>
        <div className="text-center">
          <p className="text-sm text-muted-foreground">No data available</p>
          <p className="text-xs text-muted-foreground mt-1">Waiting for time-series data...</p>
        </div>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart
        data={chartData}
        margin={{
          top: 5,
          right: 30,
          left: 20,
          bottom: 5,
        }}
      >
        {showGrid && <CartesianGrid strokeDasharray="3 3" />}
        <XAxis
          dataKey="index"
          label={{ value: 'Time', position: 'insideBottom', offset: -5 }}
        />
        <YAxis label={{ value: label, angle: -90, position: 'insideLeft' }} />
        <Tooltip
          contentStyle={{
            backgroundColor: 'hsl(var(--background))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
          }}
        />
        {showLegend && <Legend />}
        <Line
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2}
          dot={{ r: 3 }}
          activeDot={{ r: 5 }}
          name={label}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
