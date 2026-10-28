// 官方业务与模型服务使用同一公网环境；请求地址必须保留网关端口。
const SERVICE_BASE_URL = 'https://v4-i.yibiao.pro:11443/qhp-yibiao';
const AI_BASE_URL = 'https://v4-i.yibiao.pro:11443/qhp-ai/anonymous/openai/v1';

module.exports = { SERVICE_BASE_URL, AI_BASE_URL };
