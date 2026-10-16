import { useMessages } from "../../core/i18n/index";
import { desktopUpdateMessages } from "./desktopUpdateMessages";
import { useEffect, useState } from 'react';
import { desktopInstallSession, type InstallStatus } from '../../core/services/desktopUpdateInstall';

function size(bytes:number) { return `${(bytes/1024/1024).toFixed(1)} MB`; }

/** Uses the existing Settings button/panel styles; never renders release notes as HTML. */
let lastAutomaticCheck = 0;
export default function DesktopInstallPanel({active, visible, automatic, onStatus}: {active:boolean; visible:boolean; automatic:boolean; onStatus:(status:InstallStatus|null)=>void}) {
  const {t}=useMessages(desktopUpdateMessages);
  const session = desktopInstallSession();
  const [snapshot,setSnapshot] = useState(session.snapshot);
  const [confirm,setConfirm] = useState(false);
  const [actionError,setActionError] = useState(false);
  useEffect(()=>{
    const off=session.subscribe(()=>setSnapshot(session.snapshot()));
    void session.connect();
    return off;
  },[session]);
  const status=snapshot.status;
  useEffect(()=>{onStatus(status);},[status,onStatus]);
  useEffect(()=>{
    if (!active || !automatic || !status?.canCheck || !['idle','current'].includes(status.phase) || snapshot.connectionError || Date.now()-lastAutomaticCheck<86400000) return;
    lastAutomaticCheck=Date.now();
    void session.action('check').catch(()=>setActionError(true));
  },[active,automatic,status,session,snapshot.connectionError]);
  useEffect(()=>{ if(!visible || status?.phase!=='ready')setConfirm(false); },[visible,status?.phase]);
  const run=(op:'check'|'download'|'cancel'|'install'|'restart')=>{
    setActionError(false);
    if(op==='install'||op==='restart')setConfirm(false);
    void session.action(op).catch(()=>setActionError(true));
  };
  const unavailable=Boolean(snapshot.connectionError);
  const message=snapshot.connectionError ?? status?.errorCode;
  return <div className="settings-update-native" aria-busy={Boolean(status && ['checking','downloading','verifying','preparing'].includes(status.phase))}>
    <div className="settings-update-status" role="status" aria-live="polite">
      <p>{status ? t(status.phase) : t('loading')}</p>
      {status?.version && <p>{t('version',{version:status.version})}</p>}
      {(message||actionError) && <p>{message && Object.prototype.hasOwnProperty.call(desktopUpdateMessages,message) ? t(message as keyof typeof desktopUpdateMessages) : t('failed')}</p>}
    </div>
    {status?.phase==='downloading' && <div>
      <progress aria-label={t('progress')} max={status.totalBytes || undefined}
        value={status.totalBytes ? status.downloadedBytes : undefined} style={{width:'100%'}} />
      <p>{size(status.downloadedBytes)}{status.totalBytes ? ` / ${size(status.totalBytes)}` : ''}</p>
    </div>}
    <div className="settings-update-actions">
      {status?.canCheck && <button type="button" className="settings-btn" disabled={unavailable||snapshot.pending.has('check')} onClick={()=>run('check')}>{t('check')}</button>}
      {status?.canDownload && <button type="button" className="settings-btn settings-btn-primary" disabled={unavailable||snapshot.pending.has('download')} onClick={()=>run('download')}>{t('download')}</button>}
      {status?.canCancel && <button type="button" className="settings-btn" disabled={unavailable||snapshot.pending.has('cancel')} onClick={()=>run('cancel')}>{t('cancel')}</button>}
      {status?.canInstall && <button type="button" className="settings-btn settings-btn-primary" disabled={unavailable||snapshot.pending.has('install')} onClick={()=>setConfirm(true)}>{t('schedule')}</button>}
      {(status?.canInstall||status?.phase==='scheduled') && <button type="button" className="settings-btn settings-btn-primary" disabled={unavailable||snapshot.pending.has('restart')||snapshot.pending.has('install')} onClick={()=>run('restart')}>{t('restart')}</button>}
      {unavailable && <button type="button" className="settings-btn" onClick={()=>{setActionError(false);void session.reconnect();}}>{t('reconnect')}</button>}
    </div>
    {confirm && status?.canInstall && <div className="settings-update-status" role="group" aria-label={t('confirmLabel')}>
      <p>{t('confirmText')}</p>
      <div className="settings-update-actions">
        <button type="button" className="settings-btn" onClick={()=>setConfirm(false)}>{t('later')}</button>
        <button type="button" className="settings-btn settings-btn-primary" disabled={unavailable||snapshot.pending.has('install')} onClick={()=>run('install')}>{t('confirm')}</button>
      </div>
    </div>}
  </div>;
}
