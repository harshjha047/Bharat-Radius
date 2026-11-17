import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';

// 1200×630 share card for WhatsApp, LinkedIn, X and Facebook. Built once at build time.
export const alt = 'BharatRadius: RADIUS & ISP billing software for Indian broadband operators';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpenGraphImage() {
  const mark = await readFile(join(process.cwd(), 'public/brand/mark.png'));
  const src = `data:image/png;base64,${mark.toString('base64')}`;
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '64px 72px',
        background:
          'radial-gradient(60% 80% at 15% 0%, #FFD9A8 0%, rgba(255,217,168,0) 65%), radial-gradient(50% 70% at 95% 30%, #BFE9C6 0%, rgba(191,233,198,0) 66%), #FFF8EE',
        color: '#10214F',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <img src={src} width={62} height={80} alt="" />
        <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>BharatRadius</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div style={{ fontSize: 68, fontWeight: 800, lineHeight: 1.05, letterSpacing: -2, maxWidth: 1000 }}>
          RADIUS &amp; ISP billing software for Indian ISPs
        </div>
        <div style={{ fontSize: 30, color: '#4A5578', maxWidth: 980 }}>
          PPPoE · GST invoices · FUP plans · Resellers &amp; LCOs · DoT logs
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 26 }}>
        <div style={{ display: 'flex', color: '#4A5578' }}>Built on FreeRADIUS · Hosted in India</div>
        <div
          style={{
            display: 'flex',
            background: '#E8760F',
            color: 'white',
            padding: '14px 30px',
            borderRadius: 999,
            fontWeight: 700,
          }}
        >
          Book a free demo
        </div>
      </div>
    </div>,
    size,
  );
}
