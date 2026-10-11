/**
 * Countries for the registration form: calling codes, states, postal code
 * formats and tax identifiers.
 *
 * One table for both sides. The Worker checks a registration against it
 * (src/signup.ts) and the registration form reads the same data as
 * /assets/geo-<hash>.json for its lists and its instant checks, so the form can
 * never accept what the server then refuses.
 *
 * A country with no entry in STATES, POSTAL_FORMATS or TAX_IDS is not checked
 * there: its state is free text, and its postal code and tax ID are taken as
 * written. A wrong pattern would turn a real customer away, so a pattern is
 * listed only where the format is fixed and well documented.
 */

import { fnv1a } from "./ui_layout";

/** ISO 3166-1 alpha-2 code, English name, calling code digits, extra words to search by. */
type CountryRow = readonly [code: string, name: string, dial: string, aliases?: string];

export const COUNTRIES: readonly CountryRow[] = [
  ["AF", "Afghanistan", "93"],
  ["AX", "Åland Islands", "358"],
  ["AL", "Albania", "355"],
  ["DZ", "Algeria", "213"],
  ["AS", "American Samoa", "1684"],
  ["AD", "Andorra", "376"],
  ["AO", "Angola", "244"],
  ["AI", "Anguilla", "1264"],
  ["AG", "Antigua and Barbuda", "1268"],
  ["AR", "Argentina", "54"],
  ["AM", "Armenia", "374"],
  ["AW", "Aruba", "297"],
  ["AU", "Australia", "61"],
  ["AT", "Austria", "43"],
  ["AZ", "Azerbaijan", "994"],
  ["BS", "Bahamas", "1242"],
  ["BH", "Bahrain", "973"],
  ["BD", "Bangladesh", "880"],
  ["BB", "Barbados", "1246"],
  ["BY", "Belarus", "375"],
  ["BE", "Belgium", "32"],
  ["BZ", "Belize", "501"],
  ["BJ", "Benin", "229"],
  ["BM", "Bermuda", "1441"],
  ["BT", "Bhutan", "975"],
  ["BO", "Bolivia", "591"],
  ["BA", "Bosnia and Herzegovina", "387"],
  ["BW", "Botswana", "267"],
  ["BR", "Brazil", "55", "Brasil"],
  ["IO", "British Indian Ocean Territory", "246"],
  ["VG", "British Virgin Islands", "1284"],
  ["BN", "Brunei", "673"],
  ["BG", "Bulgaria", "359"],
  ["BF", "Burkina Faso", "226"],
  ["BI", "Burundi", "257"],
  ["KH", "Cambodia", "855"],
  ["CM", "Cameroon", "237"],
  ["CA", "Canada", "1"],
  ["CV", "Cape Verde", "238", "Cabo Verde"],
  ["BQ", "Caribbean Netherlands", "599", "Bonaire Sint Eustatius Saba"],
  ["KY", "Cayman Islands", "1345"],
  ["CF", "Central African Republic", "236"],
  ["TD", "Chad", "235"],
  ["CL", "Chile", "56"],
  ["CN", "China", "86"],
  ["CX", "Christmas Island", "61"],
  ["CC", "Cocos (Keeling) Islands", "61"],
  ["CO", "Colombia", "57"],
  ["KM", "Comoros", "269"],
  ["CG", "Congo (Brazzaville)", "242", "Republic of the Congo"],
  ["CD", "Congo (Kinshasa)", "243", "Democratic Republic of the Congo DRC"],
  ["CK", "Cook Islands", "682"],
  ["CR", "Costa Rica", "506"],
  ["CI", "Côte d'Ivoire", "225", "Ivory Coast"],
  ["HR", "Croatia", "385"],
  ["CU", "Cuba", "53"],
  ["CW", "Curaçao", "599"],
  ["CY", "Cyprus", "357"],
  ["CZ", "Czechia", "420", "Czech Republic"],
  ["DK", "Denmark", "45"],
  ["DJ", "Djibouti", "253"],
  ["DM", "Dominica", "1767"],
  ["DO", "Dominican Republic", "1809"],
  ["EC", "Ecuador", "593"],
  ["EG", "Egypt", "20"],
  ["SV", "El Salvador", "503"],
  ["GQ", "Equatorial Guinea", "240"],
  ["ER", "Eritrea", "291"],
  ["EE", "Estonia", "372"],
  ["SZ", "Eswatini", "268", "Swaziland"],
  ["ET", "Ethiopia", "251"],
  ["FK", "Falkland Islands", "500"],
  ["FO", "Faroe Islands", "298"],
  ["FJ", "Fiji", "679"],
  ["FI", "Finland", "358"],
  ["FR", "France", "33"],
  ["GF", "French Guiana", "594"],
  ["PF", "French Polynesia", "689"],
  ["GA", "Gabon", "241"],
  ["GM", "Gambia", "220"],
  ["GE", "Georgia", "995"],
  ["DE", "Germany", "49", "Deutschland"],
  ["GH", "Ghana", "233"],
  ["GI", "Gibraltar", "350"],
  ["GR", "Greece", "30"],
  ["GL", "Greenland", "299"],
  ["GD", "Grenada", "1473"],
  ["GP", "Guadeloupe", "590"],
  ["GU", "Guam", "1671"],
  ["GT", "Guatemala", "502"],
  ["GG", "Guernsey", "44"],
  ["GN", "Guinea", "224"],
  ["GW", "Guinea-Bissau", "245"],
  ["GY", "Guyana", "592"],
  ["HT", "Haiti", "509"],
  ["HN", "Honduras", "504"],
  ["HK", "Hong Kong", "852"],
  ["HU", "Hungary", "36"],
  ["IS", "Iceland", "354"],
  ["IN", "India", "91", "Bharat"],
  ["ID", "Indonesia", "62"],
  ["IR", "Iran", "98"],
  ["IQ", "Iraq", "964"],
  ["IE", "Ireland", "353"],
  ["IM", "Isle of Man", "44"],
  ["IL", "Israel", "972"],
  ["IT", "Italy", "39", "Italia"],
  ["JM", "Jamaica", "1876"],
  ["JP", "Japan", "81"],
  ["JE", "Jersey", "44"],
  ["JO", "Jordan", "962"],
  ["KZ", "Kazakhstan", "7"],
  ["KE", "Kenya", "254"],
  ["KI", "Kiribati", "686"],
  ["XK", "Kosovo", "383"],
  ["KW", "Kuwait", "965"],
  ["KG", "Kyrgyzstan", "996"],
  ["LA", "Laos", "856"],
  ["LV", "Latvia", "371"],
  ["LB", "Lebanon", "961"],
  ["LS", "Lesotho", "266"],
  ["LR", "Liberia", "231"],
  ["LY", "Libya", "218"],
  ["LI", "Liechtenstein", "423"],
  ["LT", "Lithuania", "370"],
  ["LU", "Luxembourg", "352"],
  ["MO", "Macao", "853", "Macau"],
  ["MG", "Madagascar", "261"],
  ["MW", "Malawi", "265"],
  ["MY", "Malaysia", "60"],
  ["MV", "Maldives", "960"],
  ["ML", "Mali", "223"],
  ["MT", "Malta", "356"],
  ["MH", "Marshall Islands", "692"],
  ["MQ", "Martinique", "596"],
  ["MR", "Mauritania", "222"],
  ["MU", "Mauritius", "230"],
  ["YT", "Mayotte", "262"],
  ["MX", "Mexico", "52", "México"],
  ["FM", "Micronesia", "691"],
  ["MD", "Moldova", "373"],
  ["MC", "Monaco", "377"],
  ["MN", "Mongolia", "976"],
  ["ME", "Montenegro", "382"],
  ["MS", "Montserrat", "1664"],
  ["MA", "Morocco", "212"],
  ["MZ", "Mozambique", "258"],
  ["MM", "Myanmar", "95", "Burma"],
  ["NA", "Namibia", "264"],
  ["NR", "Nauru", "674"],
  ["NP", "Nepal", "977"],
  ["NL", "Netherlands", "31", "Holland"],
  ["NC", "New Caledonia", "687"],
  ["NZ", "New Zealand", "64"],
  ["NI", "Nicaragua", "505"],
  ["NE", "Niger", "227"],
  ["NG", "Nigeria", "234"],
  ["NU", "Niue", "683"],
  ["NF", "Norfolk Island", "672"],
  ["KP", "North Korea", "850"],
  ["MK", "North Macedonia", "389"],
  ["MP", "Northern Mariana Islands", "1670"],
  ["NO", "Norway", "47"],
  ["OM", "Oman", "968"],
  ["PK", "Pakistan", "92"],
  ["PW", "Palau", "680"],
  ["PS", "Palestine", "970"],
  ["PA", "Panama", "507"],
  ["PG", "Papua New Guinea", "675"],
  ["PY", "Paraguay", "595"],
  ["PE", "Peru", "51"],
  ["PH", "Philippines", "63"],
  ["PL", "Poland", "48"],
  ["PT", "Portugal", "351"],
  ["PR", "Puerto Rico", "1787"],
  ["QA", "Qatar", "974"],
  ["RE", "Réunion", "262"],
  ["RO", "Romania", "40"],
  ["RU", "Russia", "7"],
  ["RW", "Rwanda", "250"],
  ["BL", "Saint Barthélemy", "590"],
  ["SH", "Saint Helena", "290"],
  ["KN", "Saint Kitts and Nevis", "1869"],
  ["LC", "Saint Lucia", "1758"],
  ["MF", "Saint Martin", "590"],
  ["PM", "Saint Pierre and Miquelon", "508"],
  ["VC", "Saint Vincent and the Grenadines", "1784"],
  ["WS", "Samoa", "685"],
  ["SM", "San Marino", "378"],
  ["ST", "São Tomé and Príncipe", "239"],
  ["SA", "Saudi Arabia", "966", "KSA"],
  ["SN", "Senegal", "221"],
  ["RS", "Serbia", "381"],
  ["SC", "Seychelles", "248"],
  ["SL", "Sierra Leone", "232"],
  ["SG", "Singapore", "65"],
  ["SX", "Sint Maarten", "1721"],
  ["SK", "Slovakia", "421"],
  ["SI", "Slovenia", "386"],
  ["SB", "Solomon Islands", "677"],
  ["SO", "Somalia", "252"],
  ["ZA", "South Africa", "27"],
  ["KR", "South Korea", "82", "Korea Republic of"],
  ["SS", "South Sudan", "211"],
  ["ES", "Spain", "34", "España"],
  ["LK", "Sri Lanka", "94"],
  ["SD", "Sudan", "249"],
  ["SR", "Suriname", "597"],
  ["SJ", "Svalbard and Jan Mayen", "47"],
  ["SE", "Sweden", "46"],
  ["CH", "Switzerland", "41"],
  ["SY", "Syria", "963"],
  ["TW", "Taiwan", "886"],
  ["TJ", "Tajikistan", "992"],
  ["TZ", "Tanzania", "255"],
  ["TH", "Thailand", "66"],
  ["TL", "Timor-Leste", "670", "East Timor"],
  ["TG", "Togo", "228"],
  ["TK", "Tokelau", "690"],
  ["TO", "Tonga", "676"],
  ["TT", "Trinidad and Tobago", "1868"],
  ["TN", "Tunisia", "216"],
  ["TR", "Türkiye", "90", "Turkey"],
  ["TM", "Turkmenistan", "993"],
  ["TC", "Turks and Caicos Islands", "1649"],
  ["TV", "Tuvalu", "688"],
  ["VI", "U.S. Virgin Islands", "1340"],
  ["UG", "Uganda", "256"],
  ["UA", "Ukraine", "380"],
  ["AE", "United Arab Emirates", "971", "UAE Emirates"],
  ["GB", "United Kingdom", "44", "UK Great Britain England Scotland Wales"],
  ["US", "United States", "1", "USA America"],
  ["UY", "Uruguay", "598"],
  ["UZ", "Uzbekistan", "998"],
  ["VU", "Vanuatu", "678"],
  ["VA", "Vatican City", "39", "Holy See"],
  ["VE", "Venezuela", "58"],
  ["VN", "Vietnam", "84", "Viet Nam"],
  ["WF", "Wallis and Futuna", "681"],
  ["EH", "Western Sahara", "212"],
  ["YE", "Yemen", "967"],
  ["ZM", "Zambia", "260"],
  ["ZW", "Zimbabwe", "263"]
];

/** What a country calls its first-level division, and the divisions themselves. */
export const STATES: Readonly<Record<string, { label: string; names: readonly string[] }>> = {
  AE: { label: "Emirate", names: ["Abu Dhabi", "Ajman", "Dubai", "Fujairah", "Ras Al Khaimah", "Sharjah", "Umm Al Quwain"] },
  AU: {
    label: "State or territory",
    names: ["Australian Capital Territory", "New South Wales", "Northern Territory", "Queensland", "South Australia", "Tasmania", "Victoria", "Western Australia"]
  },
  BR: {
    label: "State",
    names: [
      "Acre", "Alagoas", "Amapá", "Amazonas", "Bahia", "Ceará", "Distrito Federal", "Espírito Santo", "Goiás", "Maranhão",
      "Mato Grosso", "Mato Grosso do Sul", "Minas Gerais", "Pará", "Paraíba", "Paraná", "Pernambuco", "Piauí", "Rio de Janeiro",
      "Rio Grande do Norte", "Rio Grande do Sul", "Rondônia", "Roraima", "Santa Catarina", "São Paulo", "Sergipe", "Tocantins"
    ]
  },
  CA: {
    label: "Province or territory",
    names: [
      "Alberta", "British Columbia", "Manitoba", "New Brunswick", "Newfoundland and Labrador", "Northwest Territories", "Nova Scotia",
      "Nunavut", "Ontario", "Prince Edward Island", "Quebec", "Saskatchewan", "Yukon"
    ]
  },
  DE: {
    label: "State",
    names: [
      "Baden-Württemberg", "Bavaria", "Berlin", "Brandenburg", "Bremen", "Hamburg", "Hesse", "Lower Saxony", "Mecklenburg-Vorpommern",
      "North Rhine-Westphalia", "Rhineland-Palatinate", "Saarland", "Saxony", "Saxony-Anhalt", "Schleswig-Holstein", "Thuringia"
    ]
  },
  GB: { label: "Country", names: ["England", "Northern Ireland", "Scotland", "Wales"] },
  IN: {
    label: "State or union territory",
    names: [
      "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh", "Chhattisgarh",
      "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir",
      "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram",
      "Nagaland", "Odisha", "Puducherry", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh",
      "Uttarakhand", "West Bengal"
    ]
  },
  JP: {
    label: "Prefecture",
    names: [
      "Aichi", "Akita", "Aomori", "Chiba", "Ehime", "Fukui", "Fukuoka", "Fukushima", "Gifu", "Gunma", "Hiroshima", "Hokkaido", "Hyogo",
      "Ibaraki", "Ishikawa", "Iwate", "Kagawa", "Kagoshima", "Kanagawa", "Kochi", "Kumamoto", "Kyoto", "Mie", "Miyagi", "Miyazaki",
      "Nagano", "Nagasaki", "Nara", "Niigata", "Oita", "Okayama", "Okinawa", "Osaka", "Saga", "Saitama", "Shiga", "Shimane", "Shizuoka",
      "Tochigi", "Tokushima", "Tokyo", "Tottori", "Toyama", "Wakayama", "Yamagata", "Yamaguchi", "Yamanashi"
    ]
  },
  MX: {
    label: "State",
    names: [
      "Aguascalientes", "Baja California", "Baja California Sur", "Campeche", "Chiapas", "Chihuahua", "Ciudad de México", "Coahuila",
      "Colima", "Durango", "Guanajuato", "Guerrero", "Hidalgo", "Jalisco", "México", "Michoacán", "Morelos", "Nayarit", "Nuevo León",
      "Oaxaca", "Puebla", "Querétaro", "Quintana Roo", "San Luis Potosí", "Sinaloa", "Sonora", "Tabasco", "Tamaulipas", "Tlaxcala",
      "Veracruz", "Yucatán", "Zacatecas"
    ]
  },
  MY: {
    label: "State or federal territory",
    names: [
      "Johor", "Kedah", "Kelantan", "Kuala Lumpur", "Labuan", "Malacca", "Negeri Sembilan", "Pahang", "Penang", "Perak", "Perlis",
      "Putrajaya", "Sabah", "Sarawak", "Selangor", "Terengganu"
    ]
  },
  NG: {
    label: "State",
    names: [
      "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue", "Borno", "Cross River", "Delta", "Ebonyi", "Edo", "Ekiti",
      "Enugu", "Federal Capital Territory", "Gombe", "Imo", "Jigawa", "Kaduna", "Kano", "Katsina", "Kebbi", "Kogi", "Kwara", "Lagos",
      "Nasarawa", "Niger", "Ogun", "Ondo", "Osun", "Oyo", "Plateau", "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara"
    ]
  },
  PK: {
    label: "Province or territory",
    names: ["Azad Jammu and Kashmir", "Balochistan", "Gilgit-Baltistan", "Islamabad Capital Territory", "Khyber Pakhtunkhwa", "Punjab", "Sindh"]
  },
  US: {
    label: "State",
    names: [
      "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "District of Columbia", "Florida",
      "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts",
      "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico",
      "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina",
      "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming"
    ]
  },
  ZA: {
    label: "Province",
    names: ["Eastern Cape", "Free State", "Gauteng", "KwaZulu-Natal", "Limpopo", "Mpumalanga", "North West", "Northern Cape", "Western Cape"]
  }
};

/**
 * A postal code's format and an example of one, by country. The pattern is
 * tested against the code in capitals with single spaces (`cleanPostalCode`).
 */
export const POSTAL_FORMATS: Readonly<Record<string, readonly [pattern: string, example: string]>> = {
  AD: ["^AD\\d{3}$", "AD500"],
  AF: ["^\\d{4}$", "1001"],
  AL: ["^\\d{4}$", "1001"],
  AM: ["^\\d{4}$", "0010"],
  AR: ["^([A-Z]\\d{4}[A-Z]{3}|\\d{4})$", "C1425CLA"],
  AT: ["^\\d{4}$", "1010"],
  AU: ["^\\d{4}$", "2000"],
  AZ: ["^(AZ ?)?\\d{4}$", "AZ 1000"],
  BA: ["^\\d{5}$", "71000"],
  BD: ["^\\d{4}$", "1207"],
  BE: ["^\\d{4}$", "1000"],
  BG: ["^\\d{4}$", "1000"],
  BN: ["^[A-Z]{2} ?\\d{4}$", "BS8811"],
  BR: ["^\\d{5}-?\\d{3}$", "01310-100"],
  BT: ["^\\d{5}$", "11001"],
  BY: ["^\\d{6}$", "220030"],
  CA: ["^[ABCEGHJ-NPRSTVXY]\\d[ABCEGHJ-NPRSTV-Z] ?\\d[ABCEGHJ-NPRSTV-Z]\\d$", "K1A 0B1"],
  CH: ["^\\d{4}$", "8001"],
  CL: ["^\\d{7}$", "8320000"],
  CN: ["^\\d{6}$", "100000"],
  CO: ["^\\d{6}$", "110111"],
  CR: ["^\\d{5}$", "10101"],
  CY: ["^\\d{4}$", "1010"],
  CZ: ["^\\d{3} ?\\d{2}$", "110 00"],
  DE: ["^\\d{5}$", "10115"],
  DK: ["^\\d{4}$", "1050"],
  DO: ["^\\d{5}$", "10101"],
  DZ: ["^\\d{5}$", "16000"],
  EC: ["^\\d{6}$", "170150"],
  EE: ["^\\d{5}$", "10111"],
  EG: ["^\\d{5}$", "11511"],
  ES: ["^\\d{5}$", "28001"],
  ET: ["^\\d{4}$", "1000"],
  FI: ["^\\d{5}$", "00100"],
  FO: ["^\\d{3}$", "100"],
  FR: ["^\\d{5}$", "75001"],
  GB: ["^(GIR ?0AA|[A-Z]{1,2}\\d[A-Z\\d]? ?\\d[A-Z]{2})$", "SW1A 1AA"],
  GE: ["^\\d{4}$", "0105"],
  GL: ["^\\d{4}$", "3900"],
  GR: ["^\\d{3} ?\\d{2}$", "104 31"],
  GT: ["^\\d{5}$", "01001"],
  HR: ["^\\d{5}$", "10000"],
  HU: ["^\\d{4}$", "1051"],
  ID: ["^\\d{5}$", "10110"],
  IE: ["^[A-Z]\\d[\\dW] ?[A-Z\\d]{4}$", "D02 AF30"],
  IL: ["^\\d{5}(\\d{2})?$", "9414219"],
  IN: ["^[1-9]\\d{2} ?\\d{3}$", "110001"],
  IQ: ["^\\d{5}$", "10001"],
  IR: ["^\\d{10}$", "1193653471"],
  IS: ["^\\d{3}$", "101"],
  IT: ["^\\d{5}$", "00118"],
  JO: ["^\\d{5}$", "11118"],
  JP: ["^\\d{3}-?\\d{4}$", "100-0001"],
  KE: ["^\\d{5}$", "00100"],
  KR: ["^\\d{5}$", "04524"],
  KW: ["^\\d{5}$", "13001"],
  KZ: ["^\\d{6}$", "010000"],
  LA: ["^\\d{5}$", "01000"],
  LI: ["^\\d{4}$", "9490"],
  LK: ["^\\d{5}$", "00100"],
  LT: ["^(LT-)?\\d{5}$", "LT-01100"],
  LU: ["^(L-)?\\d{4}$", "L-1009"],
  LV: ["^(LV-)?\\d{4}$", "LV-1050"],
  MA: ["^\\d{5}$", "10000"],
  MC: ["^980\\d{2}$", "98000"],
  MD: ["^(MD-?)?\\d{4}$", "MD-2001"],
  MK: ["^\\d{4}$", "1000"],
  MM: ["^\\d{5}$", "11181"],
  MT: ["^[A-Z]{3} ?\\d{4}$", "VLT 1117"],
  MV: ["^\\d{5}$", "20026"],
  MX: ["^\\d{5}$", "06000"],
  MY: ["^\\d{5}$", "50000"],
  NG: ["^\\d{6}$", "100001"],
  NL: ["^\\d{4} ?[A-Z]{2}$", "1012 AB"],
  NO: ["^\\d{4}$", "0150"],
  NP: ["^\\d{5}$", "44600"],
  NZ: ["^\\d{4}$", "6011"],
  OM: ["^\\d{3}$", "100"],
  PE: ["^\\d{5}$", "15001"],
  PH: ["^\\d{4}$", "1000"],
  PK: ["^\\d{5}$", "44000"],
  PL: ["^\\d{2}-\\d{3}$", "00-001"],
  PR: ["^\\d{5}(-\\d{4})?$", "00901"],
  PT: ["^\\d{4}-\\d{3}$", "1000-001"],
  RO: ["^\\d{6}$", "010011"],
  RS: ["^\\d{5}$", "11000"],
  RU: ["^\\d{6}$", "101000"],
  SA: ["^\\d{5}(-\\d{4})?$", "11564"],
  SE: ["^\\d{3} ?\\d{2}$", "111 20"],
  SG: ["^\\d{6}$", "018956"],
  SI: ["^\\d{4}$", "1000"],
  SK: ["^\\d{3} ?\\d{2}$", "811 01"],
  SM: ["^4789\\d$", "47890"],
  TH: ["^\\d{5}$", "10200"],
  TN: ["^\\d{4}$", "1000"],
  TR: ["^\\d{5}$", "34000"],
  TW: ["^\\d{3}(-?\\d{2,3})?$", "100"],
  UA: ["^\\d{5}$", "01001"],
  US: ["^\\d{5}(-\\d{4})?$", "94103"],
  UY: ["^\\d{5}$", "11000"],
  UZ: ["^\\d{6}$", "100000"],
  VA: ["^00120$", "00120"],
  VE: ["^\\d{4}$", "1010"],
  VN: ["^\\d{5,6}$", "100000"],
  ZA: ["^\\d{4}$", "8001"]
};

/** Countries whose addresses carry no postal code, so the form does not ask for one. */
export const NO_POSTAL_CODE: readonly string[] = [
  "AE", "AG", "AO", "AW", "BJ", "BF", "BI", "BS", "BW", "BZ", "CD", "CF", "CG", "CI", "CK", "CM", "CW", "DJ", "DM", "ER", "FJ", "GD", "GH",
  "GM", "GQ", "GY", "HK", "KI", "KM", "KN", "KP", "LC", "ML", "MO", "MR", "MW", "NR", "NU", "QA", "RW", "SB", "SC", "SL", "SO", "SR", "ST",
  "SX", "SY", "TD", "TG", "TK", "TL", "TO", "TT", "TV", "UG", "VU", "YE", "ZW"
];

interface TaxIdFormat {
  /** What the country calls the number a business is taxed under. */
  label: string;
  /** Tested against the number in capitals with no spaces (`cleanTaxId`). */
  pattern?: string;
  example?: string;
}

const EU_VAT = "VAT number";

export const TAX_IDS: Readonly<Record<string, TaxIdFormat>> = {
  AE: { label: "TRN (Tax Registration Number)", pattern: "^\\d{15}$", example: "100123456700003" },
  AR: { label: "CUIT", pattern: "^\\d{2}-?\\d{8}-?\\d$", example: "30-12345678-9" },
  AT: { label: EU_VAT, pattern: "^(AT)?U\\d{8}$", example: "ATU12345678" },
  AU: { label: "ABN", pattern: "^\\d{11}$", example: "51 824 753 556" },
  BE: { label: EU_VAT, pattern: "^(BE)?[01]\\d{9}$", example: "BE0123456789" },
  BG: { label: EU_VAT, pattern: "^(BG)?\\d{9,10}$", example: "BG123456789" },
  BR: { label: "CNPJ", pattern: "^\\d{2}\\.?\\d{3}\\.?\\d{3}/?\\d{4}-?\\d{2}$", example: "12.345.678/0001-95" },
  CA: { label: "Business Number (GST/HST)", pattern: "^\\d{9}(RT\\d{4})?$", example: "123456789RT0001" },
  CH: { label: "UID (VAT number)", pattern: "^CHE-?\\d{3}\\.?\\d{3}\\.?\\d{3}(MWST|TVA|IVA)?$", example: "CHE-123.456.789" },
  CL: { label: "RUT", pattern: "^\\d{1,2}\\.?\\d{3}\\.?\\d{3}-?[\\dK]$", example: "76.123.456-7" },
  CN: { label: "Unified Social Credit Code", pattern: "^[0-9A-Z]{18}$", example: "91350100M000100Y43" },
  CY: { label: EU_VAT, pattern: "^(CY)?\\d{8}[A-Z]$", example: "CY12345678X" },
  CZ: { label: EU_VAT, pattern: "^(CZ)?\\d{8,10}$", example: "CZ12345678" },
  DE: { label: "VAT number (USt-IdNr.)", pattern: "^(DE)?\\d{9}$", example: "DE123456789" },
  DK: { label: "CVR / VAT number", pattern: "^(DK)?\\d{8}$", example: "DK12345678" },
  EE: { label: EU_VAT, pattern: "^(EE)?\\d{9}$", example: "EE123456789" },
  ES: { label: "NIF / VAT number", pattern: "^(ES)?[0-9A-Z]\\d{7}[0-9A-Z]$", example: "ESB12345678" },
  FI: { label: EU_VAT, pattern: "^(FI)?\\d{8}$", example: "FI12345678" },
  FR: { label: "VAT number (TVA)", pattern: "^(FR)?[0-9A-Z]{2}\\d{9}$", example: "FR12345678901" },
  GB: { label: "VAT registration number", pattern: "^(GB)?(\\d{9}|\\d{12})$", example: "GB123456789" },
  GR: { label: EU_VAT, pattern: "^(EL|GR)?\\d{9}$", example: "EL123456789" },
  HR: { label: "OIB / VAT number", pattern: "^(HR)?\\d{11}$", example: "HR12345678901" },
  HU: { label: EU_VAT, pattern: "^(HU)?\\d{8}$", example: "HU12345678" },
  IE: { label: EU_VAT, pattern: "^(IE)?(\\d{7}[A-Z]{1,2}|\\d[A-Z+*]\\d{5}[A-Z])$", example: "IE1234567T" },
  IL: { label: "Company or VAT number", pattern: "^\\d{9}$", example: "512345678" },
  IN: { label: "GSTIN", pattern: "^\\d{2}[A-Z]{5}\\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$", example: "27AAPFU0939F1ZV" },
  IT: { label: "Partita IVA", pattern: "^(IT)?\\d{11}$", example: "IT12345678901" },
  JP: { label: "Corporate Number", pattern: "^T?\\d{13}$", example: "1234567890123" },
  KE: { label: "KRA PIN", pattern: "^[AP]\\d{9}[A-Z]$", example: "P051234567X" },
  KR: { label: "Business Registration Number", pattern: "^\\d{3}-?\\d{2}-?\\d{5}$", example: "123-45-67890" },
  LT: { label: EU_VAT, pattern: "^(LT)?(\\d{9}|\\d{12})$", example: "LT123456789" },
  LU: { label: EU_VAT, pattern: "^(LU)?\\d{8}$", example: "LU12345678" },
  LV: { label: EU_VAT, pattern: "^(LV)?\\d{11}$", example: "LV12345678901" },
  MT: { label: EU_VAT, pattern: "^(MT)?\\d{8}$", example: "MT12345678" },
  MX: { label: "RFC", pattern: "^[A-ZÑ&]{3,4}\\d{6}[A-Z0-9]{3}$", example: "ABC680524P76" },
  MY: { label: "SST registration or TIN" },
  NL: { label: "VAT number (btw-id)", pattern: "^(NL)?\\d{9}B\\d{2}$", example: "NL123456789B01" },
  NO: { label: "Organisation number (MVA)", pattern: "^(NO)?\\d{9}(MVA)?$", example: "NO123456789MVA" },
  NZ: { label: "GST number (IRD)", pattern: "^\\d{8,9}$", example: "123456789" },
  PE: { label: "RUC", pattern: "^\\d{11}$", example: "20123456789" },
  PL: { label: "NIP / VAT number", pattern: "^(PL)?\\d{10}$", example: "PL1234567890" },
  PT: { label: "NIF / VAT number", pattern: "^(PT)?\\d{9}$", example: "PT123456789" },
  RO: { label: "CUI / VAT number", pattern: "^(RO)?\\d{2,10}$", example: "RO12345678" },
  RU: { label: "INN", pattern: "^(\\d{10}|\\d{12})$", example: "7707083893" },
  SA: { label: "VAT registration number", pattern: "^\\d{15}$", example: "300123456700003" },
  SE: { label: EU_VAT, pattern: "^(SE)?\\d{12}$", example: "SE123456789001" },
  SG: { label: "UEN / GST registration number", pattern: "^[0-9A-Z]{9,10}$", example: "201912345K" },
  SI: { label: EU_VAT, pattern: "^(SI)?\\d{8}$", example: "SI12345678" },
  SK: { label: EU_VAT, pattern: "^(SK)?\\d{10}$", example: "SK1234567890" },
  TH: { label: "Tax Identification Number", pattern: "^\\d{13}$", example: "0105512345678" },
  TR: { label: "Vergi Kimlik No (VKN)", pattern: "^\\d{10}$", example: "1234567890" },
  US: { label: "EIN", pattern: "^\\d{2}-?\\d{7}$", example: "12-3456789" },
  ZA: { label: "VAT number", pattern: "^4\\d{9}$", example: "4123456789" }
};

/** The label for a country with no entry in TAX_IDS. */
export const DEFAULT_TAX_ID_LABEL = "Tax ID";

const BY_CODE = new Map(COUNTRIES.map((row) => [row[0], row] as const));
const BY_NAME = new Map(COUNTRIES.map((row) => [row[1].toLowerCase(), row] as const));

export interface Country {
  code: string;
  name: string;
  dial: string;
}

/** The country a form sent: its ISO code, or its English name as listed here. */
export function findCountry(raw: unknown): Country | null {
  const value = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  const row = BY_CODE.get(value.toUpperCase()) || BY_NAME.get(value.toLowerCase());
  return row ? { code: row[0], name: row[1], dial: row[2] } : null;
}

/** A postal code as it is compared: capitals, single spaces. */
export function cleanPostalCode(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 20);
}

/** A tax ID as it is compared: capitals, no spaces. */
export function cleanTaxId(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, "").toUpperCase().slice(0, 40);
}

/** Whether this country's addresses carry a postal code. */
export function needsPostalCode(countryCode: string): boolean {
  return !NO_POSTAL_CODE.includes(countryCode);
}

/** What is wrong with this postal code for this country, or null. */
export function postalCodeProblem(countryCode: string, postalCode: string): string | null {
  const format = POSTAL_FORMATS[countryCode];
  if (!format || !postalCode) return null;
  return new RegExp(format[0]).test(postalCode) ? null : `That is not a postal code of this country. Example: ${format[1]}`;
}

/** The division as this country lists it, or null when it is not one of them. */
export function findState(countryCode: string, raw: unknown): string | null {
  const wanted = String(raw ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const states = STATES[countryCode];
  if (!states || !wanted) return null;
  return states.names.find((name) => name.toLowerCase() === wanted) || null;
}

/** What is wrong with this tax ID for this country, or null. */
export function taxIdProblem(countryCode: string, taxId: string): string | null {
  const format = TAX_IDS[countryCode];
  if (!format || !format.pattern || !taxId) return null;
  return new RegExp(format.pattern).test(taxId) ? null : `That is not a valid ${format.label}. Example: ${format.example}`;
}

/** The table as the registration form reads it. */
export const GEO_JSON = JSON.stringify({
  countries: COUNTRIES,
  states: STATES,
  postal: POSTAL_FORMATS,
  noPostal: NO_POSTAL_CODE,
  tax: TAX_IDS,
  taxLabel: DEFAULT_TAX_ID_LABEL
});

/** Served immutable under the hash of its text, as the stylesheets are. */
export const GEO_DATA_PATH = `/assets/geo-${fnv1a(GEO_JSON)}.json`;
