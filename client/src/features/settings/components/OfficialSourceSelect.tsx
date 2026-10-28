import type { OfficialAccountState } from '../../../shared/types/officialAccount';

/** 当前账户与本人历史来源共用选择器，只切换查询范围。 */
export default function OfficialSourceSelect({ account, value, onChange }: {
  account: OfficialAccountState;
  value: string;
  onChange: (value: string) => void;
}) {
  if (account.identityType !== 'email' || !account.sources.length) return null;
  return <select aria-label="查询来源" value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="">当前账户</option>
    {account.sources.map((source) => <option key={source.sourceAccountId} value={source.sourceAccountId}>历史个人来源 · {source.sourceAccountId}</option>)}
  </select>;
}
