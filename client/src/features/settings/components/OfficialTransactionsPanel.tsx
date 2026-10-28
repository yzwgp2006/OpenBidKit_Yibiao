import { useEffect, useState } from 'react';
import type { OfficialAccountState, OfficialTransactionsPage } from '../../../shared/types/officialAccount';
import { InlineSpinner, useToast } from '../../../shared/ui';
import { useOfficialAccount } from './useOfficialAccount';
import OfficialSourceSelect from './OfficialSourceSelect';

const consumeLabels = { TEXT_GENERATION: '文本生成', REASONING: '深度推理', IMAGE_GENERATION: '图片生成' };
const columns = ['消费时间', '请求编号', '类型', '消耗 e点', '结算后余额 e点'];

// 账户或身份变化时重新挂载列表，清除前一身份的数据和页码。
export default function OfficialTransactionsPanel() {
  const account = useOfficialAccount();
  if (account.status !== 'signed-in' || !account.identityType) {
    return <p className="official-api-empty">{account.status === 'loading' ? '正在读取账户…' : '请先在账号处登录后查看流水'}</p>;
  }
  return <TransactionsList key={`${account.subjectId}:${account.accountId}:${account.email}:${account.identityType}`} account={account} />;
}

// 服务端分页查询；页面卸载和翻页后忽略迟到响应。
function TransactionsList({ account }: { account: OfficialAccountState }) {
  const [page, setPage] = useState(1);
  const [sourceAccountId, setSourceAccountId] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<OfficialTransactionsPage | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const { showToast } = useToast();

  useEffect(() => {
    let disposed = false;
    setStatus('loading');
    setData(null);
    void window.yibiao.officialAccount.getTransactions({ page, sourceAccountId }).then((result) => {
      if (disposed) return;
      if (page > 1 && !result.records.length) { setPage(page - 1); return; }
      setData(result);
      setStatus('ready');
    }).catch((error) => {
      if (disposed) return;
      setStatus('error');
      showToast(error instanceof Error ? error.message : '流水加载失败，请重试', 'error');
    });
    return () => { disposed = true; };
  }, [page, sourceAccountId, account.balanceRevision, attempt, showToast]);

  return (
    <>
      <div className="official-orders-toolbar">
        <span role="status">{status === 'loading' ? '正在加载流水…' : status === 'error' ? '流水加载失败' : '已结算消费流水'}</span>
        <OfficialSourceSelect account={account} value={sourceAccountId} onChange={(value) => { setSourceAccountId(value); setPage(1); }} />
        <button type="button" className="inline-action" disabled={status === 'loading'} onClick={() => setAttempt((value) => value + 1)}>{status === 'loading' ? <><InlineSpinner />加载中…</> : status === 'error' ? '重试' : '刷新'}</button>
      </div>
      <table className="official-api-table official-orders-table" aria-label="流水记录" aria-busy={status === 'loading'}>
        <thead><tr>{columns.map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>
          {status === 'loading' && <tr><td colSpan={columns.length}><div className="official-table-loading" role="status"><InlineSpinner /><span>正在加载流水…</span></div></td></tr>}
          {status !== 'loading' && data?.records.map((record) => (
            <tr key={record.id}>
              <td>{record.createTime}</td><td>{record.requestNo || '—'}</td>
              <td>{consumeLabels[record.operationType] || record.operationType}</td><td>{record.consumePoint}</td>
              <td>{record.availableAfter ?? '—'}</td>
            </tr>
          ))}
          {status !== 'loading' && !data?.records.length && <tr><td colSpan={columns.length} className="official-api-empty">{status === 'error' ? '请重试加载流水' : '暂无流水'}</td></tr>}
        </tbody>
      </table>
      {status === 'ready' && data && (data.records.length > 0 || page > 1) && (
        <nav className="official-orders-toolbar" aria-label="流水分页">
          <button type="button" className="inline-action" disabled={data.current <= 1} onClick={() => setPage(data.current - 1)}>上一页</button>
          <span role="status">第 {data.current} 页 · 每页 {data.size} 条</span>
          <button type="button" className="inline-action" disabled={!data.hasMore} onClick={() => setPage(data.current + 1)}>下一页</button>
        </nav>
      )}
    </>
  );
}
