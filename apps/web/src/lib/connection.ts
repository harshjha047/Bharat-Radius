export type ConnectionType = 'pppoe' | 'hotspot' | 'static';
export const CONNECTION_LABEL: Record<ConnectionType, string> = {
  pppoe: 'PPPoE',
  hotspot: 'Hotspot',
  static: 'Static IP',
};
export const CONNECTION_TYPES = Object.keys(CONNECTION_LABEL) as ConnectionType[];
export const isConnectionType = (v: string | null): v is ConnectionType =>
  v !== null && v in CONNECTION_LABEL;
