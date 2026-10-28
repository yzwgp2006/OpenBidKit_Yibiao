import { useEffect, useRef, useState } from 'react';
import type { OfficialInvoice, OfficialInvoiceInfo, OfficialRechargeOrder } from '../../../shared/types/officialAccount';
import { AppDialog, useToast } from '../../../shared/ui';

/** 查询单笔开票状态；首次申请和驳回重提使用已保存的资料。 */
export default function OfficialInvoiceAction({ order, isEmailAccount, onSubmitted }: { isEmailAccount: boolean; order: OfficialRechargeOrder; onSubmitted: () => void }) {
  const [info, setInfo] = useState<OfficialInvoiceInfo | null>(null);
  const [invoice, setInvoice] = useState<OfficialInvoice | null>(null);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const active = useRef(true);
  const pending = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { showToast } = useToast();

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  // 每次点击重新读取数据库，个人资料不要求税号。
  async function open() {
    if (pending.current) return;
    if (!isEmailAccount) {
      showToast('请先在账号处绑定邮箱后再申请开票', 'info');
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      const current = await window.yibiao.officialAccount.getInvoiceApplication(order.orderNo);
      if (!active.current) return;
      setInvoice(current);
      setSubmitError('');
      setInfo(null);
      if (current && current.status !== 'REJECTED') { setOpened(true); return; }
      const saved = await window.yibiao.officialAccount.getInvoiceInfo();
      if (!active.current) return;
      if (!saved.buyer.trim() || !saved.email.trim() || (saved.titleType === 'enterprise' && !saved.taxNumber.trim())) {
        showToast('请先在“开票信息”中填写完整的开票信息', 'info');
        return;
      }
      if (saved.buyer.trim().length > 200 || (saved.titleType === 'enterprise' && saved.taxNumber.trim().length > 64) || saved.email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(saved.email.trim())) {
        showToast('开票信息格式不正确，请先在“开票信息”中检查购买方、公司税号和邮箱', 'error');
        return;
      }
      setInfo(saved);
      setOpened(true);
    } catch (error) {
      if (active.current) showToast(error instanceof Error ? error.message : '开票信息读取失败，请重试', 'error');
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  // 关闭弹窗并恢复键盘焦点。
  function close() {
    setOpened(false);
    setInfo(null);
    requestAnimationFrame(() => trigger.current?.focus());
  }

  // 驳回重提携带刚查到的版本，避免覆盖已处理的申请。
  async function submit() {
    if (!info || pending.current) return;
    pending.current = true;
    setBusy(true);
    setSubmitError('');
    try {
      await window.yibiao.officialAccount.createInvoiceApplication({
        orderNo: order.orderNo,
        titleType: info.titleType === 'enterprise' ? 'ENTERPRISE' : 'PERSONAL',
        invoiceTitle: info.buyer.trim(),
        taxpayerNo: info.titleType === 'enterprise' ? info.taxNumber.trim() : '',
        receiverEmail: info.email.trim(),
        ...(invoice ? { version: invoice.version } : {}),
      });
      if (!active.current) return;
      close();
      showToast('开票申请已提交', 'success');
      onSubmitted();
    } catch (error) {
      if (active.current) {
        const message = error instanceof Error ? error.message : '开票申请提交失败，请重试';
        setSubmitError(message);
        showToast(message, 'error');
      }
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  return <>
    <button ref={trigger} type="button" className="inline-action" disabled={busy} onClick={() => { void open(); }}>{busy ? '正在处理…' : '开票 / 状态'}</button>
    {opened && <AppDialog open title={info ? '申请开票' : '开票状态'} description={`订单号：${order.orderNo}`} preventClose={busy} onOpenChange={(value) => { if (!value && !busy) close(); }} actions={<>
      <button type="button" className="secondary-action" disabled={busy} onClick={close}>关闭</button>
      {info && <button type="button" className="primary-action" disabled={busy} onClick={() => { void submit(); }}>{busy ? '正在提交…' : invoice ? '重新提交' : '提交申请'}</button>}
    </>}>
      {invoice && <p>申请状态：{{ PENDING: '待处理', REJECTED: '已驳回', ISSUED: '已开票' }[invoice.status]} · 邮件：{{ NOT_SENT: '待发送', SENT: '已发送', FAILED: '发送失败，请联系客服' }[invoice.mailStatus]}</p>}
      {invoice?.rejectReason && <p>驳回原因：{invoice.rejectReason}</p>}
      <dl className="official-order-detail">
        <dt>发票抬头</dt><dd>{info?.buyer || invoice?.invoiceTitle}</dd>
        {info?.titleType === 'enterprise' && <><dt>企业税号</dt><dd>{info.taxNumber}</dd></>}
        <dt>接收邮箱</dt><dd>{info?.email || invoice?.receiverEmail}</dd>
      </dl>
      {submitError && <p role="alert">{submitError}</p>}
    </AppDialog>}
  </>;
}
