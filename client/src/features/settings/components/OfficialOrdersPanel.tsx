import { useEffect, useRef, useState } from 'react';
import type { OfficialAccountState, OfficialRechargeOrder, OfficialRefund } from '../../../shared/types/officialAccount';
import { AppDialog, InlineSpinner, useToast } from '../../../shared/ui';
import { useOfficialAccount } from './useOfficialAccount';
import OfficialRechargeDialog from './OfficialRechargeDialog';
import OfficialInvoiceAction from './OfficialInvoiceAction';
import OfficialSourceSelect from './OfficialSourceSelect';

const paymentLabels = { WAITING: '待支付', PAID: '支付成功', CLOSED: '已关闭' };
const refundLabels = { NONE: '', PENDING: '退款处理中', SUCCESS: '已退款', FAILED: '退款失败' };

// 身份变化时重建列表，清除原账户的页码及弹窗。
export default function OfficialOrdersPanel() {
  const account = useOfficialAccount();
  if (account.status !== 'signed-in') return <p className="official-api-empty">{account.status === 'loading' ? '正在读取账户…' : '请先在账号处登录后查看订单'}</p>;
  return <OrdersList key={`${account.subjectId}:${account.accountId}:${account.email}:${account.identityType}`} account={account} />;
}

function OrdersList({ account }: { account: OfficialAccountState }) {
  const [orders, setOrders] = useState<OfficialRechargeOrder[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [sourceAccountId, setSourceAccountId] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [detail, setDetail] = useState<OfficialRechargeOrder | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [closing, setClosing] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [confirmRefund, setConfirmRefund] = useState(false);
  const [refunds, setRefunds] = useState<OfficialRefund[]>([]);
  const [refundError, setRefundError] = useState('');
  const [refundAttempt, setRefundAttempt] = useState(0);
  const [resuming, setResuming] = useState<string | null>(null);
  const [paymentOrder, setPaymentOrder] = useState<OfficialRechargeOrder | null>(null);
  const detailRequest = useRef(0);
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  const { showToast } = useToast();

  useEffect(() => {
    setOrders([]);
    setDetail(null);
    setConfirmRefund(false);
    setPaymentOrder(null);
    detailRequest.current++;
    let disposed = false;
    const updates = new Map<string, OfficialRechargeOrder>();
    setStatus('loading');
    const unsubscribe = window.yibiao.officialAccount.onRechargeOrderChanged((order) => {
      if (disposed) return;
      updates.set(order.id, order);
      setOrders((current) => current.map((item) => item.id === order.id ? order : item));
      setDetail((current) => current?.id === order.id ? order : current);
    });
    void window.yibiao.officialAccount.getRechargeOrders({ page, sourceAccountId }).then((result) => {
      if (disposed) return;
      if (page > 1 && !result.records.length) { setPage(page - 1); return; }
      setOrders(result.records.map((item) => updates.get(item.id) || item));
      setHasMore(result.hasMore);
      setStatus('ready');
    }).catch((error) => {
      if (disposed) return;
      setStatus('error');
      showToast(error instanceof Error ? error.message : '订单加载失败', 'error');
    });
    return () => { disposed = true; detailRequest.current++; unsubscribe(); };
  }, [page, sourceAccountId, attempt, showToast]);

  useEffect(() => {
    setRefunds([]);
    setRefundError('');
    if (!detail || !account.isTeamAdmin || detail.status !== 'PAID'
      || detail.settledSubjectType !== 'TENANT' || detail.settledSubjectId !== account.subjectId) return;
    let disposed = false;
    void window.yibiao.officialAccount.getRefunds(detail.orderNo).then((items) => {
      if (!disposed) setRefunds(items);
    }).catch((error) => {
      if (!disposed) setRefundError(error instanceof Error ? error.message : '退款记录读取失败');
    });
    return () => { disposed = true; };
  }, [detail?.orderNo, detail?.status, detail?.refundStatus, account.isTeamAdmin, account.subjectId, refundAttempt]);

  // 先展示所选订单，再查询最新详情；关闭后忽略迟到结果。
  const openDetail = async (order: OfficialRechargeOrder, trigger: HTMLButtonElement) => {
    const request = ++detailRequest.current;
    detailTrigger.current = trigger;
    setDetail(order);
    setConfirmRefund(false);
    setDetailLoading(true);
    try {
      const latest = await window.yibiao.officialAccount.getRechargeOrder(order.orderNo);
      if (request === detailRequest.current) setDetail(latest);
    } catch (error) {
      if (request === detailRequest.current) showToast(error instanceof Error ? error.message : '订单详情加载失败', 'error');
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  };

  // 关闭详情并恢复到列表中的订单入口。
  const closeDetail = () => {
    detailRequest.current++;
    setDetail(null);
    setPaymentOrder(null);
    requestAnimationFrame(() => detailTrigger.current?.focus());
  };

  // 重查待支付状态后再打开本机缓存的二维码，不创建新订单。
  const resumePayment = async (order: OfficialRechargeOrder, trigger?: HTMLButtonElement) => {
    if (resuming) return;
    const request = ++detailRequest.current;
    if (trigger) detailTrigger.current = trigger;
    setResuming(order.id);
    try {
      const latest = await window.yibiao.officialAccount.getRechargeOrder(order.orderNo);
      if (request !== detailRequest.current) return;
      setDetail((current) => current?.id === latest.id ? latest : current);
      if (latest.status !== 'WAITING') showToast(paymentLabels[latest.status], 'info');
      else if (!latest.qrCode) showToast('本机没有可用的支付二维码，可在订单详情中关闭该订单后重新充值。', 'info');
      else { setDetail(null); setPaymentOrder(latest); }
    } catch (error) {
      if (request === detailRequest.current) showToast(error instanceof Error ? error.message : '支付二维码加载失败', 'error');
    } finally {
      setResuming(null);
    }
  };

  // 返回已支付时照实展示；失败后的状态重查和通知由 Main 处理。
  const closeOrder = async () => {
    if (!detail || closing || resuming) return;
    const request = detailRequest.current;
    setClosing(true);
    try {
      const latest = await window.yibiao.officialAccount.closeRechargeOrder(detail.orderNo);
      if (request !== detailRequest.current) return;
      setDetail(latest);
      showToast(latest.status === 'CLOSED' ? '订单已关闭' : paymentLabels[latest.status], latest.status === 'CLOSED' ? 'success' : 'info');
    } catch (error) {
      if (request === detailRequest.current) showToast(error instanceof Error ? error.message : '关闭订单失败，请刷新订单状态', 'error');
    } finally {
      setClosing(false);
    }
  };

  // 全额退款由服务端裁决资格及扣点；不自动重提失败请求。
  const refundOrder = async () => {
    if (!detail || refunding) return;
    const request = detailRequest.current;
    setRefunding(true);
    try {
      const refund = await window.yibiao.officialAccount.createRefund(detail.orderNo);
      if (request !== detailRequest.current) return;
      showToast(refundLabels[refund.status], refund.status === 'FAILED' ? 'error' : 'info');
    } catch (error) {
      if (request === detailRequest.current) showToast(error instanceof Error ? error.message : '退款提交失败，请先核对退款记录', 'error');
    } finally {
      setRefunding(false);
      setConfirmRefund(false);
      setRefundAttempt((value) => value + 1);
    }
  };
  const canRefund = detail?.status === 'PAID' && account.isTeamAdmin
    && detail.settledSubjectType === 'TENANT' && detail.settledSubjectId === account.subjectId
    && (detail.refundStatus === 'NONE' || detail.refundStatus === 'FAILED');

  return (
    <>
      <div className="official-orders-toolbar">
        <span role="status">{status === 'loading' ? '正在加载订单…' : status === 'error' ? '订单加载失败' : '充值订单'}</span>
        <OfficialSourceSelect account={account} value={sourceAccountId} onChange={(value) => { setSourceAccountId(value); setPage(1); }} />
        <button type="button" className="inline-action" disabled={status === 'loading'} onClick={() => setAttempt((value) => value + 1)}>{status === 'loading' ? <><InlineSpinner />加载中…</> : status === 'error' ? '重试' : '刷新'}</button>
      </div>
      <table className="official-api-table official-orders-table" aria-label="订单记录" aria-busy={status === 'loading'}>
        <thead><tr>{['时间', '订单号', '金额', 'e点', '状态', '操作'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>
          {status === 'loading' && <tr><td colSpan={6}><div className="official-table-loading" role="status"><InlineSpinner /><span>正在加载订单…</span></div></td></tr>}
          {status !== 'loading' && orders.map((order) => (
            <tr key={order.id}>
              <td>{order.createTime}</td>
              <td><button type="button" className="official-order-link" onClick={(event) => { void openDetail(order, event.currentTarget); }}>{order.orderNo}</button></td>
              <td>¥{order.amountYuan}</td>
              <td>{order.rechargePoint}</td>
              <td><span className={`official-order-status is-${order.status === 'PAID' ? 'success' : order.status.toLowerCase()}`}>{paymentLabels[order.status]}</span>{order.refundStatus !== 'NONE' && <small className="official-order-refund">{refundLabels[order.refundStatus]}</small>}</td>
              <td>{order.status === 'WAITING' && <button type="button" className="inline-action" disabled={!!resuming} onClick={(event) => { void resumePayment(order, event.currentTarget); }}>{resuming === order.id ? '正在读取…' : '继续支付'}</button>}
                {order.status === 'PAID' && <OfficialInvoiceAction isEmailAccount={account.identityType === 'email'} order={order} onSubmitted={() => setAttempt((value) => value + 1)} />}
              </td>
            </tr>
          ))}
          {status !== 'loading' && orders.length === 0 && <tr><td colSpan={6} className="official-api-empty">{status === 'error' ? '请重试加载订单' : '暂无订单'}</td></tr>}
        </tbody>
      </table>
      {status === 'ready' && (orders.length > 0 || page > 1) && (
        <nav className="official-orders-toolbar" aria-label="订单分页">
          <button type="button" className="inline-action" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
          <span role="status">第 {page} 页 · 每页 5 条</span>
          <button type="button" className="inline-action" disabled={!hasMore} onClick={() => setPage(page + 1)}>下一页</button>
        </nav>
      )}
      {detail && (
        <AppDialog open onOpenChange={(open) => { if (!open) closeDetail(); }} title="订单详情" description={detail.orderNo} cardClassName="official-order-dialog" preventClose={closing || refunding || !!resuming} actions={(
          <>
            <button type="button" className="secondary-action" disabled={closing || refunding || !!resuming} onClick={closeDetail}>关闭</button>
            {canRefund && <button type="button" className="secondary-action" disabled={closing || refunding || detailLoading} onClick={() => { if (confirmRefund) void refundOrder(); else setConfirmRefund(true); }}>{refunding ? '正在提交…' : confirmRefund ? '确认全额退款' : '申请退款'}</button>}
            {detail.status === 'WAITING' && <>
              <button type="button" className="secondary-action" disabled={closing || !!resuming || detailLoading} onClick={() => { void closeOrder(); }}>{closing ? '正在关闭…' : '关闭订单'}</button>
              <button type="button" className="primary-action" disabled={closing || !!resuming || detailLoading} onClick={() => { void resumePayment(detail); }}>{resuming ? '正在读取…' : '继续支付'}</button>
            </>}
          </>
        )}>
          <dl className="official-order-detail" aria-busy={detailLoading}>
            <dt>商品</dt><dd>{detail.productNameSnapshot || '自定义充值'}</dd>
            <dt>金额</dt><dd>¥{detail.amountYuan}</dd>
            <dt>e点</dt><dd>{detail.rechargePoint}</dd>
            <dt>创建时间</dt><dd>{detail.createTime}</dd>
            <dt>支付完成时间</dt><dd>{detail.paidTime || '—'}</dd>
            <dt>支付状态</dt><dd>{paymentLabels[detail.status]}{detailLoading && <InlineSpinner />}</dd>
            {detail.refundStatus !== 'NONE' && <><dt>退款状态</dt><dd>{refundLabels[detail.refundStatus]}</dd></>}
          </dl>
          {confirmRefund && <p>将申请原路全额退款 ¥{detail.amountYuan}，并由服务端核定扣回点数和退款资格。是否确认？</p>}
          {refunds.map((refund) => <p key={refund.refundNo}>{refund.createTime} · {refundLabels[refund.status]} · 扣回 {refund.deductPoint} e点{refund.failureCode ? ` · ${refund.failureCode}` : ''}</p>)}
          {refundError && <p role="alert">{refundError}</p>}
        </AppDialog>
      )}
      {paymentOrder && <OfficialRechargeDialog initialOrder={paymentOrder} onClose={closeDetail} onViewOrders={closeDetail} />}
    </>
  );
}
