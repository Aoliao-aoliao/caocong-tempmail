import { randomInt } from 'node:crypto';

export const US_ADDRESS_STATES = [
  ['AL','Alabama','Montgomery','36104','334','32.3777','-86.3006'],
  ['AK','Alaska','Anchorage','99501','907','61.2176','-149.8997'],
  ['AZ','Arizona','Phoenix','85004','602','33.4484','-112.0740'],
  ['AR','Arkansas','Little Rock','72201','501','34.7465','-92.2896'],
  ['CA','California','Sacramento','95814','916','38.5816','-121.4944'],
  ['CO','Colorado','Denver','80203','303','39.7392','-104.9903'],
  ['CT','Connecticut','Hartford','06103','860','41.7658','-72.6734'],
  ['DE','Delaware','Dover','19901','302','39.1582','-75.5244'],
  ['FL','Florida','Tallahassee','32301','850','30.4383','-84.2807'],
  ['GA','Georgia','Atlanta','30303','404','33.7490','-84.3880'],
  ['HI','Hawaii','Honolulu','96813','808','21.3069','-157.8583'],
  ['ID','Idaho','Boise','83702','208','43.6150','-116.2023'],
  ['IL','Illinois','Springfield','62701','217','39.7817','-89.6501'],
  ['IN','Indiana','Indianapolis','46204','317','39.7684','-86.1581'],
  ['IA','Iowa','Des Moines','50309','515','41.5868','-93.6250'],
  ['KS','Kansas','Topeka','66603','785','39.0473','-95.6752'],
  ['KY','Kentucky','Frankfort','40601','502','38.2009','-84.8777'],
  ['LA','Louisiana','Baton Rouge','70802','225','30.4515','-91.1871'],
  ['ME','Maine','Augusta','04330','207','44.3106','-69.7795'],
  ['MD','Maryland','Annapolis','21401','410','38.9784','-76.4922'],
  ['MA','Massachusetts','Boston','02108','617','42.3601','-71.0589'],
  ['MI','Michigan','Lansing','48933','517','42.7325','-84.5555'],
  ['MN','Minnesota','Saint Paul','55101','651','44.9537','-93.0900'],
  ['MS','Mississippi','Jackson','39201','601','32.2988','-90.1848'],
  ['MO','Missouri','Jefferson City','65101','573','38.5767','-92.1735'],
  ['MT','Montana','Helena','59601','406','46.5891','-112.0391'],
  ['NE','Nebraska','Lincoln','68508','402','40.8136','-96.7026'],
  ['NV','Nevada','Carson City','89701','775','39.1638','-119.7674'],
  ['NH','New Hampshire','Concord','03301','603','43.2081','-71.5376'],
  ['NJ','New Jersey','Trenton','08608','609','40.2171','-74.7429'],
  ['NM','New Mexico','Santa Fe','87501','505','35.6870','-105.9378'],
  ['NY','New York','Albany','12207','518','42.6526','-73.7562'],
  ['NC','North Carolina','Raleigh','27601','919','35.7796','-78.6382'],
  ['ND','North Dakota','Bismarck','58501','701','46.8083','-100.7837'],
  ['OH','Ohio','Columbus','43215','614','39.9612','-82.9988'],
  ['OK','Oklahoma','Oklahoma City','73102','405','35.4676','-97.5164'],
  ['OR','Oregon','Salem','97301','503','44.9429','-123.0351'],
  ['PA','Pennsylvania','Harrisburg','17101','717','40.2732','-76.8867'],
  ['RI','Rhode Island','Providence','02903','401','41.8240','-71.4128'],
  ['SC','South Carolina','Columbia','29201','803','34.0007','-81.0348'],
  ['SD','South Dakota','Pierre','57501','605','44.3683','-100.3510'],
  ['TN','Tennessee','Nashville','37219','615','36.1627','-86.7816'],
  ['TX','Texas','Austin','78701','512','30.2672','-97.7431'],
  ['UT','Utah','Salt Lake City','84111','801','40.7608','-111.8910'],
  ['VT','Vermont','Montpelier','05602','802','44.2601','-72.5754'],
  ['VA','Virginia','Richmond','23219','804','37.5407','-77.4360'],
  ['WA','Washington','Olympia','98501','360','47.0379','-122.9007'],
  ['WV','West Virginia','Charleston','25301','304','38.3498','-81.6326'],
  ['WI','Wisconsin','Madison','53703','608','43.0731','-89.4012'],
  ['WY','Wyoming','Cheyenne','82001','307','41.1400','-104.8202'],
  ['DC','District of Columbia','Washington','20001','202','38.9072','-77.0369'],
];

const FIRST_NAMES = [
  'Avery','Cameron','Jordan','Morgan','Riley','Taylor','Casey','Parker','Drew','Reese',
  'Amelia','Charlotte','Evelyn','Harper','Lucy','Mason','Ethan','Lucas','Owen','Caleb',
];
const LAST_NAMES = [
  'Bennett','Hayes','Morgan','Parker','Reed','Sullivan','Turner','Walker','Brooks','Collins',
  'Carter','Foster','Hughes','Jenkins','Morris','Powell','Russell','Sanders','Ward','Wood',
];
const STREET_NAMES = [
  'Cedar Lane','Maple Avenue','Juniper Ridge Road','Beacon Street','Willow Drive',
  'Lakeview Court','Highland Way','River Road','Oak Street','Washington Avenue',
];

const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function pick(items) {
  return items[randomInt(0, items.length)];
}

export function normalizeUsStateCode(value) {
  const stateCode = String(value || '').trim().toUpperCase();
  if (!stateCode) return '';
  if (!US_ADDRESS_STATES.some(([code]) => code === stateCode)) {
    throw httpError('请选择有效的州。');
  }
  return stateCode;
}

export function createAddressMailboxLocalPart() {
  const numeric = randomInt(100, 1000);
  const suffix = randomInt(0, 36 * 36).toString(36).padStart(2, '0');
  return `${numeric}${suffix}`;
}

export const NO_STATE_SALES_TAX = ['AK','DE','MT','NH','OR'];

export function createUsAddressProfile({ stateCode: rawStateCode, domain, localPart, taxFreeOnly = false }) {
  const stateCode = normalizeUsStateCode(rawStateCode);
  if (typeof taxFreeOnly !== 'boolean') throw httpError('请求筛选条件无效。');
  if (taxFreeOnly && stateCode && !NO_STATE_SALES_TAX.includes(stateCode)) throw httpError('请选择无州销售税的州。');
  const eligibleStates = taxFreeOnly ? US_ADDRESS_STATES.filter(([code]) => NO_STATE_SALES_TAX.includes(code)) : US_ADDRESS_STATES;
  const normalizedDomain = String(domain || '').trim().toLowerCase();
  if (!domainPattern.test(normalizedDomain) || normalizedDomain.length > 253) {
    throw httpError('当前没有可用收信域名。', 503);
  }
  if (!/^[a-z0-9][a-z0-9._-]{4,31}$/.test(String(localPart || ''))) {
    throw httpError('邮箱地址生成失败，请稍后重试。', 503);
  }

  const state = stateCode
    ? US_ADDRESS_STATES.find(([code]) => code === stateCode)
    : pick(eligibleStates);
  const [selectedCode, stateName, city, zipCode, areaCode, latitude, longitude] = state;
  const firstName = pick(FIRST_NAMES);
  const lastName = pick(LAST_NAMES);
  const streetAddress = `${randomInt(100, 10000)} ${pick(STREET_NAMES)}`;
  const phone = `+1 (${areaCode}) ${randomInt(200, 1000)}-${randomInt(1000, 10000)}`;

  return {
    firstName,
    lastName,
    gender: randomInt(0, 2) ? '女' : '男',
    phone,
    email: `${localPart}@${normalizedDomain}`,
    streetAddress,
    city,
    stateName,
    stateCode: selectedCode,
    zipCode,
    latitude:Number(latitude),
    longitude:Number(longitude),
    coordinates: `${latitude}, ${longitude}`,
    fullAddress: `${streetAddress}, ${city}, ${selectedCode} ${zipCode}, United States`,
  };
}
