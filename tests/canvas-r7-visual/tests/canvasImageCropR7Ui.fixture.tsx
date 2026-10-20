// Synthetic-only contract fixture: real production editor and CSS, no bridge,
// uploads, provider calls, remote assets, or production-only test hooks.
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CanvasImageTools } from '../src/features/canvas/CanvasImageTools';
import { CanvasMotionProvider } from '../src/features/canvas/CanvasMotionContext';
import type { ImageEdit } from '../src/core/canvas/imageEditing';
import type { DeliveryItem } from '../src/core/canvas/mediaDelivery';
import '../src/core/theme/themeTokens.css';
import '../src/features/canvas/canvasCreative.css';

function quadrants(width: number, height: number, colors: string[]) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  colors.forEach((color, index) => {
    context.fillStyle = color;
    context.fillRect((index % 2) * width / 2, Math.floor(index / 2) * height / 2, width / 2, height / 2);
  });
  return canvas.toDataURL('image/png');
}

const items: Record<'primary' | 'secondary', DeliveryItem> = {
  primary: {
    id: 'quadrants-primary', kind: 'image', label: 'Synthetic RGBY · 400 × 300',
    source: quadrants(400, 300, ['#ff0000', '#00ff00', '#0000ff', '#ffff00']),
  },
  secondary: {
    id: 'quadrants-secondary', kind: 'image', label: 'Synthetic CMWK · 320 × 240',
    source: quadrants(320, 240, ['#00ffff', '#ff00ff', '#ffffff', '#000000']),
  },
};
type Action = 'source-primary' | 'source-secondary' | 'hold-save' | 'release-save';
type Saved = {
  itemId: string;
  width: number;
  height: number;
  bytes: number;
  mime: string;
  pngBase64: string;
  edit: ImageEdit;
  // Independent decoding of the emitted PNG, sampled well inside its pixels.
  pixels: { x: number; y: number; rgba: number[] }[];
};

function Fixture() {
  const [source, setSource] = useState<'primary' | 'secondary'>('primary');
  const [open, setOpen] = useState(false);
  const [hold, setHold] = useState(false);
  const [diagnostic, setDiagnostic] = useState({ invocations: 0, completed: 0, pending: false, saves: [] as Saved[] });
  const holdRef = useRef(false);
  const releaseRef = useRef<(() => void) | null>(null);
  const control = (action: Action) => {
    if (action === 'source-primary') setSource('primary');
    if (action === 'source-secondary') setSource('secondary');
    if (action === 'hold-save') { holdRef.current = true; setHold(true); }
    if (action === 'release-save') {
      holdRef.current = false;
      setHold(false);
      releaseRef.current?.();
      releaseRef.current = null;
    }
  };
  useEffect(() => {
    // Test-owned controls stay outside the modal. This event changes fixture
    // props or its onSave promise only; it cannot edit production state.
    const listener = (event: Event) => control((event as CustomEvent<Action>).detail);
    document.addEventListener('r7-crop-fixture-control', listener);
    return () => document.removeEventListener('r7-crop-fixture-control', listener);
  }, []);

  const save = async (item: DeliveryItem, blob: Blob, edit: ImageEdit) => {
    const held = holdRef.current;
    const gate = held ? new Promise<void>(resolve => { releaseRef.current = resolve; }) : Promise.resolve();
    setDiagnostic(current => ({ ...current, invocations: current.invocations + 1, pending: held }));
    const pngBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const bitmap = await createImageBitmap(blob);
    const decoded = document.createElement('canvas');
    decoded.width = bitmap.width;
    decoded.height = bitmap.height;
    const context = decoded.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels: Saved['pixels'] = [];
    for (const fy of [0.125, 0.375, 0.625, 0.875]) {
      for (const fx of [0.125, 0.375, 0.625, 0.875]) {
        const x = Math.floor(decoded.width * fx), y = Math.floor(decoded.height * fy);
        pixels.push({ x, y, rgba: Array.from(context.getImageData(x, y, 1, 1).data) });
      }
    }
    const saved: Saved = {
      itemId: item.id, width: decoded.width, height: decoded.height,
      bytes: blob.size, mime: blob.type, pngBase64, edit: { ...edit, crop: { ...edit.crop } }, pixels,
    };
    setDiagnostic(current => ({ ...current, saves: [...current.saves, saved] }));
    await gate;
    setDiagnostic(current => ({ ...current, pending: false, completed: current.completed + 1 }));
    return 'Synthetic PNG decoded; original unchanged; nothing uploaded or written.';
  };

  return <CanvasMotionProvider reduced={false}>
    <main className="crop-contract-fixture">
      <nav aria-label="Synthetic crop fixture controls" className="crop-contract-controls">
        <button type="button" onClick={() => setOpen(true)}>Open synthetic crop editor</button>
        <button type="button" onClick={() => control('source-primary')}>Use primary source</button>
        <button type="button" onClick={() => control('source-secondary')}>Use secondary source</button>
        <button type="button" aria-pressed={hold} onClick={() => control('hold-save')}>Hold save completion</button>
        <button type="button" onClick={() => control('release-save')}>Release held save</button>
      </nav>
      <p>Dedicated crop contracts · synthetic local pixels only · no native or model calls</p>
      <output id="crop-fixture-diagnostics" hidden>{JSON.stringify({ source, hold, ...diagnostic })}</output>
      {open && <CanvasImageTools english item={items[source]} onClose={() => setOpen(false)} onSave={save} />}
    </main>
  </CanvasMotionProvider>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
