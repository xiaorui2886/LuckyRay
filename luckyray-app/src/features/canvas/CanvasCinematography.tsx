import { useId } from 'react';
import {
  CINEMATOGRAPHY_OPTIONS, createDefaultCinematographySettings, normalizeCinematographySettings,
  type CinematographyField, type CinematographyKind, type CinematographySettings,
} from '../../core/canvas/cinematography';
import './CanvasCinematography.css';

export interface CanvasCinematographyProps {
  value?: CinematographySettings;
  onChange: (value: CinematographySettings) => void;
  kind: CinematographyKind;
  english: boolean;
}
const LABELS: Record<CinematographyField, readonly [string, string]> = {
  camera: ['摄影机风格', 'Camera look'], lens: ['镜头风格', 'Lens look'], focalLength: ['焦距', 'Focal length'],
  aperture: ['光圈 / 景深', 'Aperture / depth'], framing: ['景别', 'Framing'], angle: ['机位角度', 'Angle'], movement: ['运镜', 'Movement'],
};
export function CanvasCinematography({ value, onChange, kind, english }: CanvasCinematographyProps) {
  const id = useId();
  const settings = normalizeCinematographySettings(value);
  const hint = english
    ? 'Creative prompt directions interpreted by the model. Results vary; these do not set physical camera metadata or API resolution.'
    : '这些选项会加入生成提示词，由模型理解；效果可能不同，不代表真实拍摄参数，也不会更改 API 分辨率。';
  const field = (key: CinematographyField) => <label className="canvas-cinema-field" key={key} htmlFor={`${id}-${key}`}>
    <span>{LABELS[key][english ? 1 : 0]}</span>
    <select id={`${id}-${key}`} value={settings[key]} onChange={event => onChange(normalizeCinematographySettings({ ...settings, [key]: event.target.value }))}>
      {CINEMATOGRAPHY_OPTIONS[key].map(option => <option key={option[0]} value={option[0]}>{option[english ? 2 : 1]}</option>)}
    </select>
  </label>;
  const segments = (key: 'focalLength' | 'aperture') => <div className="canvas-cinema-segment-field">
    <span id={`${id}-${key}-label`}>{key === 'aperture' && <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="m6 3 7 1 4 6-3 7-8-1-3-6Z"/><path d="m6 3 1 7 7 7M13 4l-6 6-4 0m14 0-7-1-4 7"/></svg>}{LABELS[key][english ? 1 : 0]}</span>
    <div className={`canvas-cinema-segments is-${key}`} role="group" aria-labelledby={`${id}-${key}-label`}>
      {CINEMATOGRAPHY_OPTIONS[key].map(option => <button type="button" key={option[0]} aria-pressed={settings[key] === option[0]} title={option[english ? 2 : 1]} onClick={() => onChange(normalizeCinematographySettings({ ...settings, [key]: option[0] }))}>
        {option[0] === 'auto' ? (english ? 'Auto' : '自动') : key === 'aperture' ? `f/${option[0]}` : option[0]}
      </button>)}
    </div>
  </div>;
  return <section className="canvas-cinematography" aria-label={english ? 'Camera direction' : '摄影指导'}>
    <div className="canvas-cinema-heading">
      <label className="canvas-cinema-enable">
        <input type="checkbox" checked={settings.enabled} disabled={kind === 'text'} onChange={event => onChange({ ...settings, enabled: event.target.checked })} />
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="3"/><path d="m8 7 2-3h4l2 3"/><circle cx="12" cy="13.5" r="3.5"/></svg>
        <span>{english ? 'Camera direction' : '摄影指导'}</span>
      </label>
      <button type="button" className="canvas-cinema-reset" onClick={() => onChange(createDefaultCinematographySettings())}>{english ? 'Reset' : '重置'}</button>
    </div>
    <p className="canvas-cinema-hint" id={`${id}-hint`} title={hint}>{english ? 'Model-interpreted visual guidance' : '由模型理解的视觉指导'} <span aria-hidden="true">ⓘ</span><span className="canvas-cinema-sr-only">{hint}</span></p>
    {kind === 'text' ? <p className="canvas-cinema-hint">{english ? 'Available for image and video generation.' : '适用于图片与视频生成。'}</p> : <fieldset disabled={!settings.enabled} aria-describedby={`${id}-hint`}>
      <legend className="canvas-cinema-sr-only">{english ? 'Photography settings' : '摄影设置'}</legend>
      <div className="canvas-cinema-equipment">{field('camera')}{field('lens')}</div>
      <div className="canvas-cinema-optics">{segments('focalLength')}{segments('aperture')}</div>
      <div className="canvas-cinema-grid">{field('framing')}{field('angle')}</div>
      {kind === 'video' && <div className="canvas-cinema-motion">{field('movement')}</div>}
    </fieldset>}
  </section>;
}
