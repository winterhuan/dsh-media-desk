import React from 'react'
import { t } from './i18n.js'

/** Evidence stays expandable so both rule review lists retain readable summaries. */
export function RuleEvidence({ skill, skills }) {
  const related = skills.find(row => row.id === skill.relatedRuleId)
  if (!skill.evidence && !skill.scope && !skill.before && !skill.after && !related) return null
  return <details className="md-rule-evidence">
    <summary>{t('依据与相近规则')}</summary>
    {skill.scope ? <p>{t('适用范围：{scope}', { scope: skill.scope })}</p> : null}
    {skill.evidence ? <p>{t('依据：{evidence}', { evidence: skill.evidence })}</p> : null}
    {skill.before ? <p>{t('修改前：{text}', { text: skill.before })}</p> : null}
    {skill.after ? <p>{t('修改后：{text}', { text: skill.after })}</p> : null}
    {related ? <div><p>{t('相近规则：{name}', { name: related.name })}</p><p>{related.rule}</p>
      <p>{t('比较新增要求；重复的提案可删除，需要保留时再启用')}</p></div> : null}
  </details>
}
