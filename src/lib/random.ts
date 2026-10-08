// 随机身份工具仅用于生成测试资料，不参与真实邮箱和邮件数据。

import { site } from '../config/site';

export const DEFAULT_DOMAIN = site.emailDomain;

const ADDRESS_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randomToken(length = 10): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ADDRESS_CHARS[Math.floor(Math.random() * ADDRESS_CHARS.length)];
  }
  return out;
}

const ALIAS_ADJECTIVES = ['swift', 'quiet', 'amber', 'cobalt', 'lunar', 'misty', 'coral', 'ember'];
const ALIAS_NOUNS = ['otter', 'falcon', 'willow', 'harbor', 'ridge', 'comet', 'birch', 'delta'];

export function createAliasLocalPart(): string {
  const a = ALIAS_ADJECTIVES[Math.floor(Math.random() * ALIAS_ADJECTIVES.length)];
  const n = ALIAS_NOUNS[Math.floor(Math.random() * ALIAS_NOUNS.length)];
  const num = Math.floor(Math.random() * 90 + 10);
  return `${a}-${n}${num}`;
}

const FIRST_NAMES_CN = ['伟', '芳', '娜', '敏', '静', '磊', '强', '洋', '艳', '勇', '军', '杰', '娟', '涛', '明'];
const LAST_NAMES_CN = ['王', '李', '张', '刘', '陈', '杨', '黄', '赵', '周', '吴', '徐', '孙', '马', '朱', '胡'];
const STREETS_CN = ['人民路', '中山路', '解放路', '建设路', '和平路', '文化路', '光明路', '新华路'];
const CITIES_CN = ['北京市朝阳区', '上海市浦东新区', '广州市天河区', '深圳市南山区', '成都市武侯区', '杭州市西湖区'];

const FIRST_NAMES_EN = ['James', 'Mary', 'Robert', 'Patricia', 'John', 'Jennifer', 'Michael', 'Linda', 'David', 'Elizabeth'];
const LAST_NAMES_EN = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Wilson', 'Taylor'];
const STREETS_EN = ['Maple Ave', 'Oak Street', 'Pine Road', 'Cedar Lane', 'Elm Drive', 'Birch Court'];
const CITIES_EN = ['Austin, TX', 'Portland, OR', 'Denver, CO', 'Columbus, OH', 'Raleigh, NC', 'Tampa, FL'];

export interface Identity {
  name: string;
  gender: '男' | '女';
  phone: string;
  address: string;
  email: string;
  birthday: string;
}

export type CountryCode = 'us' | 'uk' | 'ca' | 'au' | 'de' | 'jp' | 'sg' | 'hk';

const COUNTRY_FORMATS: Record<CountryCode, { city: string; postal: string; phone: () => string; country: string }> = {
  us: { city: 'Austin, TX 78737', postal: '78737', phone: () => `+1 (512) ${randInt(200, 899)}-${randInt(1000, 9999)}`, country: 'United States' },
  uk: { city: 'Bristol BS8 2QR', postal: 'BS8 2QR', phone: () => `+44 117 ${randInt(100, 999)} ${randInt(1000, 9999)}`, country: 'United Kingdom' },
  ca: { city: 'Victoria, BC V8V 2L8', postal: 'V8V 2L8', phone: () => `+1 (250) ${randInt(200, 899)}-${randInt(1000, 9999)}`, country: 'Canada' },
  au: { city: 'Richmond VIC 3121', postal: '3121', phone: () => `+61 3 ${randInt(8000, 9999)} ${randInt(1000, 9999)}`, country: 'Australia' },
  de: { city: 'Hamburg 22765', postal: '22765', phone: () => `+49 40 ${randInt(100000, 999999)}`, country: 'Deutschland' },
  jp: { city: '東京都世田谷区 154-0016', postal: '154-0016', phone: () => `+81 3-${randInt(1000, 9999)}-${randInt(1000, 9999)}`, country: '日本' },
  sg: { city: 'Singapore 238877', postal: '238877', phone: () => `+65 ${randInt(6000, 9999)} ${randInt(1000, 9999)}`, country: 'Singapore' },
  hk: { city: 'Central, Hong Kong', postal: '—', phone: () => `+852 ${randInt(5000, 9999)} ${randInt(1000, 9999)}`, country: 'Hong Kong' },
};

export function createCountryIdentity(country: CountryCode = 'us'): Identity & { country: string; postalCode: string } {
  const format = COUNTRY_FORMATS[country];
  const first = FIRST_NAMES_EN[Math.floor(Math.random() * FIRST_NAMES_EN.length)];
  const last = LAST_NAMES_EN[Math.floor(Math.random() * LAST_NAMES_EN.length)];
  const street = STREETS_EN[Math.floor(Math.random() * STREETS_EN.length)];
  const localName = country === 'jp' ? `佐藤 ${['蓮', '葵', '陽菜', '悠真'][randInt(0, 3)]}` : `${first} ${last}`;
  return {
    name: localName,
    gender: Math.random() > .5 ? '男' : '女',
    phone: format.phone(),
    address: `${randInt(20, 980)} ${street}\n${format.city}\n${format.country}`,
    email: `${createAliasLocalPart()}@${DEFAULT_DOMAIN}`,
    birthday: randomBirthday(),
    country: format.country,
    postalCode: format.postal,
  };
}

export function createIdentity(locale: 'cn' | 'en' = 'cn'): Identity {
  const isMale = Math.random() > 0.5;

  if (locale === 'en') {
    const first = FIRST_NAMES_EN[Math.floor(Math.random() * FIRST_NAMES_EN.length)];
    const last = LAST_NAMES_EN[Math.floor(Math.random() * LAST_NAMES_EN.length)];
    const street = STREETS_EN[Math.floor(Math.random() * STREETS_EN.length)];
    const city = CITIES_EN[Math.floor(Math.random() * CITIES_EN.length)];
    return {
      name: `${first} ${last}`,
      gender: isMale ? '男' : '女',
      phone: `+1 (${randInt(200, 999)}) ${randInt(200, 999)}-${randInt(1000, 9999)}`,
      address: `${randInt(100, 9999)} ${street}, ${city}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}${randInt(10, 99)}@${DEFAULT_DOMAIN}`,
      birthday: randomBirthday(),
    };
  }

  const last = LAST_NAMES_CN[Math.floor(Math.random() * LAST_NAMES_CN.length)];
  const first = FIRST_NAMES_CN[Math.floor(Math.random() * FIRST_NAMES_CN.length)];
  const street = STREETS_CN[Math.floor(Math.random() * STREETS_CN.length)];
  const city = CITIES_CN[Math.floor(Math.random() * CITIES_CN.length)];
  return {
    name: `${last}${first}`,
    gender: isMale ? '男' : '女',
    phone: `1${[3, 5, 7, 8, 9][Math.floor(Math.random() * 5)]}${randInt(0, 9)}${randInt(1000, 9999)}${randInt(1000, 9999)}`.slice(0, 11),
    address: `${city}${street}${randInt(1, 300)}号`,
    email: `${randomToken(8)}@${DEFAULT_DOMAIN}`,
    birthday: randomBirthday(),
  };
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomBirthday(): string {
  const year = randInt(1970, 2004);
  const month = String(randInt(1, 12)).padStart(2, '0');
  const day = String(randInt(1, 28)).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
