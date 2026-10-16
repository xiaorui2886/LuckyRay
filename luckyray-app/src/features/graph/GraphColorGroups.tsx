import type { GraphColorGroup } from './graphPresentation';
import {useMessages} from '../../core/i18n';
import {graphMessages} from './graphMessages';

export function GraphColorGroups({groups, onChange}: {groups: GraphColorGroup[]; onChange: (groups: GraphColorGroup[]) => void}) {
  const {t} = useMessages(graphMessages);
  return <div className="graph-color-groups">
    <p className="graph-force-copy">{t('help')}</p>
    {groups.map((group, index) => <div className="graph-color-group" key={index}>
      <input type="color" aria-label={t('color', {index: index + 1})} value={group.color} onChange={event => onChange(groups.map((g, i) => i === index ? {...g, color: event.target.value} : g))} />
      <input type="text" aria-label={t('query', {index: index + 1})} placeholder={t('placeholder')} value={group.query} maxLength={200} onChange={event => onChange(groups.map((g, i) => i === index ? {...g, query: event.target.value} : g))} />
      <button type="button" aria-label={t('remove', {index: index + 1})} onClick={() => onChange(groups.filter((_, i) => i !== index))}>×</button>
    </div>)}
    <button type="button" className="graph-side-btn" disabled={groups.length >= 16} onClick={() => onChange([...groups, {query: '', color: '#8b8be8'}])}>{t('add')}</button>
  </div>;
}
