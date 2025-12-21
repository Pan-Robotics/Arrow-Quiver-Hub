import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

interface BarChartWidgetProps {
  data: Record<string, number> | number[] | string;
  label?: string;
  color?: string;
  showGrid?: boolean;
  showLegend?: boolean;
  height?: number;
}

export default function BarChartWidget({
  data,
  label = 'Value',
  color = '#82ca9d',
  showGrid = true,
  showLegend = true,
  height = 300,
}: BarChartWidgetProps) {
  // Parse data if it's a string
  let parsedData = data;
  if (typeof data === 'string') {
    try {
      parsedData = JSON.parse(data);
    } catch (e) {
      console.error('Failed to parse bar chart data:', e);
      parsedData = {};
    }
  }

  // Convert data to chart format
  let chartData: Array<{ name: string; value: number }> = [];

  if (Array.isArray(parsedData)) {
    // Array of numbers: use index as category name
    chartData = parsedData.map((value, index) => ({
      name: `Item ${index + 1}`,
      value: typeof value === 'number' ? value : 0,
    }));
  } else if (typeof parsedData === 'object' && parsedData !== null) {
    // Object with key-value pairs
    chartData = Object.entries(parsedData).map(([key, value]) => ({
      name: key,
      value: typeof value === 'number' ? value : 0,
    }));
  }

  if (chartData.length === 0) {
    return (
      <div className="w-full flex items-center justify-center bg-muted rounded-lg" style={{ height }}>
        <div className="text-center">
          <p className="text-sm text-muted-foreground">No data available</p>
          <p className="text-xs text-muted-foreground mt-1">Waiting for categorical data...</p>
        </div>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
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
          dataKey="name"
          angle={-45}
          textAnchor="end"
          height={80}
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
        <Bar
          dataKey="value"
          fill={color}
          name={label}
          radius={[4, 4, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
