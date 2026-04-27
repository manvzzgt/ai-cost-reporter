DROP TABLE IF EXISTS ai_costs_db.data;

CREATE EXTERNAL TABLE ai_costs_db.data (
  date           string,
  project_id     string,
  user_name      string,
  model          string,
  operation_type string,
  tier           string,
  input_units    bigint,
  output_units   bigint,
  cached_tokens  bigint,
  unit_type      string,
  requests       bigint,
  total_usd      double,
  total_mxn      double,
  fx_rate        double,
  sku_raw        string
)
PARTITIONED BY (
  provider string,
  year     string,
  month    string,
  day      string
)
ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
STORED AS INPUTFORMAT  'org.apache.hadoop.mapred.TextInputFormat'
OUTPUTFORMAT 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat'
LOCATION 's3://ai-costs-lake/data/'
TBLPROPERTIES (
  'projection.enabled'            = 'true',

  'projection.provider.type'      = 'enum',
  'projection.provider.values'    = 'openai,vertex_ai,elevenlabs,deepgram,vapi',

  'projection.year.type'          = 'integer',
  'projection.year.range'         = '2026,2030',
  'projection.year.digits'        = '4',

  'projection.month.type'         = 'integer',
  'projection.month.range'        = '1,12',
  'projection.month.digits'       = '2',

  'projection.day.type'           = 'integer',
  'projection.day.range'          = '1,31',
  'projection.day.digits'         = '2',

  'storage.location.template'     = 's3://ai-costs-lake/data/provider=${provider}/year=${year}/month=${month}/day=${day}/',

  'classification'                = 'json',
  'typeOfData'                    = 'file'
);
