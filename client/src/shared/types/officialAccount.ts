/** 官方账户在页面上的展示状态，不包含开放令牌。 */
export interface OfficialAccountState {
  status: 'loading' | 'signed-out' | 'signed-in';
  clientId: string;
  identityType: 'anonymous' | 'email' | null;
  error: string;
  email: string | null;
  accountId: string | null;
  availablePoint: string | null;
  subjectId: string | null;
  teamName: string | null;
  isTeamAdmin: boolean;
  netRechargePoint: string | null;
  totalConsumePoint: string | null;
  balanceRevision: number;
  sources: Array<{ sourceAccountId: string }>;
}

export type OfficialEmailPurpose = 'LOGIN' | 'BIND';

export interface OfficialEmailCredentials {
  email: string;
  code: string;
}

/** 当前身份可查询的已结算消费；编号、点数保留服务端字符串精度。 */
export interface OfficialConsumeRecord {
  id: string;
  requestNo: string | null;
  operationType: 'TEXT_GENERATION' | 'REASONING' | 'IMAGE_GENERATION';
  consumePoint: string;
  availableAfter: string | null;
  createTime: string;
}

/** 匿名和邮箱身份共用消费记录分页结构。 */
export interface OfficialPage<T> {
  current: number;
  size: number;
  hasMore: boolean;
  records: T[];
}

export type OfficialTransactionsPage = OfficialPage<OfficialConsumeRecord>;
export interface OfficialPageQuery { page: number; sourceAccountId?: string }

/** 充值商品展示信息；价格和点数保留服务端字符串精度。 */
export interface OfficialRechargeOption {
  id: string;
  name: string;
  amountYuan: string;
  rechargePoint: string;
}

/** 服务端充值订单；二维码仅在创建响应中返回。 */
export interface OfficialRechargeOrder {
  id: string;
  orderNo: string;
  productNameSnapshot: string | null;
  amountYuan: string;
  rechargePoint: string;
  status: 'WAITING' | 'PAID' | 'CLOSED';
  refundStatus: 'NONE' | 'PENDING' | 'SUCCESS' | 'FAILED';
  sourceSubjectType: string;
  sourceSubjectId: string;
  settledSubjectType: string | null;
  settledSubjectId: string | null;
  qrCode: string | null;
  createTime: string;
  paidTime: string | null;
  prepayExpireTime: string;
}

export interface OfficialRefund {
  refundNo: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  deductPoint: string;
  createTime: string;
  successTime: string | null;
  failureCode: string | null;
}

export interface OfficialInvoice {
  status: 'PENDING' | 'REJECTED' | 'ISSUED';
  mailStatus: 'NOT_SENT' | 'SENT' | 'FAILED';
  rejectReason: string | null;
  invoiceTitle: string;
  receiverEmail: string;
  version: number;
}

/** 本地数据库保存的开票信息。 */
export interface OfficialInvoiceInfo {
  titleType: 'enterprise' | 'individual';
  buyer: string;
  taxNumber: string;
  email: string;
}

/** 提交单笔订单的开票申请。 */
export interface OfficialInvoiceApplicationInput {
  orderNo: string;
  titleType: 'ENTERPRISE' | 'PERSONAL';
  invoiceTitle: string;
  taxpayerNo: string;
  receiverEmail: string;
  version?: number;
}
