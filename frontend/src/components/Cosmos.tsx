import { useEffect, useRef } from 'react';

/**
 * The cinematic backdrop: stars, a lit planetary limb and a glowing network of city lights.
 * Performance: the planet is painted ONCE into an offscreen sprite and only blitted per frame; the live layer is a few
 * hundred cheap primitives. DPR is capped, the loop pauses when hidden, and reduced motion draws a single still frame.
 * `progress` (0..1, via ref so React never re-renders) drives the scroll parallax.
 */
type Props = { progress: { current: number }; reduced: boolean };

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export default function Cosmos({ progress, reduced }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d', { alpha: false })!;
    let W = 0, H = 0, dpr = 1, raf = 0, alive = true, visible = true;
    let sprite: HTMLCanvasElement | null = null;
    let limbY = 0, R = 0, cx = 0;
    type Star = { x: number; y: number; r: number; a: number; s: number; p: number };
    type City = { x: number; y: number; r: number; p: number; s: number };
    let stars: Star[] = [];
    let cities: City[] = [];
    let edges: [number, number][] = [];

    const build = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      W = cv.clientWidth; H = cv.clientHeight;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      R = Math.max(W * 1.15, H * 1.3);
      cx = W / 2; limbY = H * 0.76;

      stars = Array.from({ length: Math.round(Math.min(220, (W * H) / 7000)) }, () => ({
        x: Math.random() * W, y: Math.random() * H * 0.85, r: rnd(0.3, 1.25), a: rnd(0.25, 0.9), s: rnd(0.4, 1.4), p: rnd(0, 6.28),
      }));

      // planet sprite (static)
      const sh = Math.ceil(H - limbY + 120);
      const sp = document.createElement('canvas');
      sp.width = Math.round(W * dpr); sp.height = Math.round(sh * dpr);
      const g = sp.getContext('2d')!;
      g.scale(dpr, dpr);
      const oy = 100; // sprite origin: limb top sits at y = oy
      const scy = oy + R;
      const body = g.createRadialGradient(cx, scy - R * 0.15, R * 0.4, cx, scy, R);
      body.addColorStop(0, '#04070f'); body.addColorStop(0.9, '#061024'); body.addColorStop(1, '#0a2250');
      g.fillStyle = body; g.beginPath(); g.arc(cx, scy, R, 0, 6.2832); g.fill();
      // atmosphere glow layers
      for (const [w, a, c] of [[90, 0.05, '40,110,255'], [46, 0.09, '50,130,255'], [20, 0.16, '90,170,255'], [8, 0.3, '140,205,255'], [2.2, 0.95, '210,235,255']] as const) {
        g.strokeStyle = `rgba(${c},${a})`; g.lineWidth = w;
        g.beginPath(); g.arc(cx, scy, R - w / 2 + 1, Math.PI * 1.12, Math.PI * 1.88); g.stroke();
      }
      // soft surface sheen
      const sheen = g.createLinearGradient(0, oy, 0, oy + 260);
      sheen.addColorStop(0, 'rgba(60,120,230,0.28)'); sheen.addColorStop(1, 'rgba(0,0,0,0)');
      g.save(); g.beginPath(); g.arc(cx, scy, R - 2, 0, 6.2832); g.clip(); g.fillStyle = sheen; g.fillRect(0, oy, W, 300); g.restore();

      // city network on the sphere surface
      const n = Math.round(Math.min(90, W / 14));
      cities = []; edges = [];
      for (let i = 0; i < n; i++) {
        const t = Math.random();
        const x = rnd(-0.05, 1.05) * W;
        const depth = Math.pow(t, 0.8) * (H - limbY - 20) + 14;
        const surf = scy - Math.sqrt(Math.max(R * R - (x - cx) ** 2, 0));
        cities.push({ x, y: surf + depth, r: rnd(0.7, 1.9), p: rnd(0, 6.28), s: rnd(0.6, 1.6) });
      }
      cities.forEach((a, i) => {
        cities.map((b, j) => ({ j, d: Math.hypot(a.x - b.x, (a.y - b.y) * 1.8) })).filter((o) => o.j > i && o.d < W * 0.13)
          .sort((p, q) => p.d - q.d).slice(0, 2).forEach((o) => edges.push([i, o.j]));
      });
      g.lineWidth = 0.6; g.strokeStyle = 'rgba(255,190,100,0.32)';
      g.beginPath(); edges.forEach(([i, j]) => { g.moveTo(cities[i].x, cities[i].y); g.lineTo(cities[j].x, cities[j].y); }); g.stroke();
      // arcs in space
      g.strokeStyle = 'rgba(120,180,255,0.16)'; g.lineWidth = 1;
      for (const k of [0.5, 0.78]) { g.beginPath(); g.ellipse(cx, scy, R * 1.0 + k * 140, R + k * 140, 0, Math.PI * 1.2, Math.PI * 1.8); g.stroke(); }
      sprite = sp;
      // shift cities into screen space
      cities.forEach((c) => (c.y += limbY - oy));
    };

    const frame = (t: number) => {
      if (!alive) return;
      raf = 0;
      const p = Math.min(Math.max(progress.current, 0), 1);
      const lift = p * H * 0.34; // planet sinks as you scroll
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#02040a'); bg.addColorStop(0.7, '#050b1a'); bg.addColorStop(1, '#070f22');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

      const s = t / 1000;
      for (const st of stars) {
        const a = st.a * (0.55 + 0.45 * Math.sin(s * st.s + st.p));
        ctx.fillStyle = `rgba(215,230,255,${a})`;
        ctx.fillRect(st.x, st.y - p * H * 0.08 * st.r, st.r, st.r);
      }
      // vertical beam
      const bx = cx, bgm = ctx.createLinearGradient(0, 0, 0, limbY * 0.5);
      bgm.addColorStop(0, 'rgba(120,180,255,0.85)'); bgm.addColorStop(1, 'rgba(120,180,255,0)');
      ctx.globalAlpha = (0.55 + 0.25 * Math.sin(s * 1.6)) * (1 - p * 1.4 > 0 ? 1 - p * 1.4 : 0);
      ctx.fillStyle = bgm; ctx.fillRect(bx - 0.75, 0, 1.5, limbY * 0.5);
      ctx.globalAlpha = 1;

      if (sprite) {
        const dy = limbY - 100 + lift;
        ctx.globalAlpha = 1 - p * 0.35;
        ctx.drawImage(sprite, 0, dy, W, sprite.height / dpr);
        // live layer: twinkling lights + travelling pulses
        ctx.globalCompositeOperation = 'lighter';
        for (const c of cities) {
          const a = 0.35 + 0.65 * Math.max(0, Math.sin(s * c.s + c.p));
          ctx.fillStyle = `rgba(255,${170 + (c.r * 30) | 0},90,${a * 0.9})`;
          ctx.beginPath(); ctx.arc(c.x, c.y + lift, c.r, 0, 6.2832); ctx.fill();
        }
        const pn = Math.min(14, edges.length);
        for (let k = 0; k < pn; k++) {
          const [i, j] = edges[(k * 7) % edges.length];
          const u = (s * 0.25 + k * 0.37) % 1;
          const a = cities[i], b = cities[j];
          ctx.fillStyle = 'rgba(255,230,170,0.95)';
          ctx.beginPath(); ctx.arc(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u + lift, 1.7, 0, 6.2832); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      }
      if (!reduced && visible) raf = requestAnimationFrame(frame);
    };

    const start = () => { if (!raf && alive) raf = requestAnimationFrame(frame); };
    build();
    start();
    let rt = 0;
    const onResize = () => { clearTimeout(rt); rt = window.setTimeout(() => { build(); start(); }, 150); };
    const onVis = () => { visible = !document.hidden; if (visible) start(); };
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVis);
    if (reduced) window.addEventListener('scroll', start, { passive: true });
    return () => {
      alive = false; cancelAnimationFrame(raf); clearTimeout(rt);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', start);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [progress, reduced]);

  return <canvas ref={ref} className="cosmos" aria-hidden="true" />;
}
