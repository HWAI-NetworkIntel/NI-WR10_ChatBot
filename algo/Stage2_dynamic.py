# -*- coding: utf-8 -*-
"""
Stage 2 (dynamic) - recompute network scores and ranks for drop scenarios.

Reads only the lookup CSVs written by Stage1_static.py (no raw data is touched here).

A drop removes a hospital Health System, or a physician group, from the networks of one
payor x plan type x plan id scope (same network selection as Stage0_1 / Stage0_2).
Several drops can be passed in one call and each drop carries its own scope.

Only the counties where rows were actually removed are recomputed:
    s_c counts (Stage0 logic) -> Stage1 high / PU counts -> count normalisation (Stage2)
    -> Category, pro_score, HWAI blend, 15-85 scaling (Stage2) -> ranks (Stage3)
Every other county is copied from the baseline, then ranks are recalculated.

Usage:
    import Stage2_dynamic as s2

    s2.current_rank(payor='<payor>', plan_type='HMO', plan_id='H1234_001')

    ranked = s2.run_scenario([
        {'type': 'health_system', 'name': '<health system>',
         'payor': '<payor>', 'plan_type': 'HMO', 'plan_id': None},
        {'type': 'group', 'name': ['<group 1>', '<group 2>'],
         'payor': '<payor>', 'plan_type': ['HMO', 'PPO'], 'plan_id': ['H1234_001']},
    ])
    s2.rank_view(ranked, payor='<payor>', plan_type='HMO', plan_id='H1234_001')

Scope keys left as None are not filtered on (same as Stage0_1 / Stage0_2).
"""

import os
import numpy as np
import pandas as pd
import warnings
warnings.filterwarnings('ignore')

########################################## Paths ##########################################
# Folder holding the lookup CSVs written by Stage1_static.py (Stage1_static sets this too)
LOOKUP_DIR = os.environ.get('NI_LOOKUP_DIR') or r"C:\Users\ArshpreetSaini\OneDrive - TEG Business Solutions Pvt Ltd\Desktop\Work Related\AI Hackathon/"
if not LOOKUP_DIR.endswith(('/', '\\')):
    LOOKUP_DIR += os.sep

######################################### Settings ########################################
FIPS = 'FIPS State County Code'

# Stage0_1 / Stage0_2 plan type mapping used to pick the networks of a scope
PLAN_MAP = {
    'HMO': 'HMO',
    'HMO *': 'HMO',
    'HMO-POS': 'HMO',
    'HMO-POS *': 'HMO',
    'Local PPO': 'PPO',
    'Local PPO *': 'PPO',
    'Regional PPO': 'PPO',
    'Regional PPO *': 'PPO'
}

# Stage3 settings
PAYOR_COL = 'Parent_Organization'
ENROLLMENT_COL = 'July_2026'     # enrollment used as weight
RANK_SCOPE = ['county_name']     # ranks are computed within each county; set to [] for statewide ranks
PLAN_TYPE_RULES = {
    'HMO': 'HMO',
    'HMO-POS': 'HMO',
    'Local PPO': 'PPO',
    'Regional PPO': 'PPO',
    'PPO': 'PPO',          # already mapped (Stage3 output used as input)
}
RANK_LEVELS = {
    'rank_payor_plantype_planid': [PAYOR_COL, 'Plan_Type', 'PlanID'],
    'rank_payor_plantype': [PAYOR_COL, 'Plan_Type'],
    'rank_payor': [PAYOR_COL],
}

# Stage0_2 settings
PHY_KEYS = ['state', 'county_name', FIPS, 'network_id', 'New Flag']
SC_COUNTS = ['npi_count_with_low_include_hosp',
             'npi_count_without_low_include_hosp',
             'npi_count_with_low_exclude_hosp',
             'npi_count_without_low_exclude_hosp']
HML = ['High', 'Medium', 'Low', 'LOCATION CONFIDENCE NOT AVAILABLE']
HM = ['High', 'Medium']
MEDICARE_NETS = {1, 2, 10001, 10002, 10000}

# Stage2 renames of the s_c count columns per New Flag (order = merge order in Stage2)
PHY_FLAG_RENAME = {
    'PCP': {'npi_count_with_low_exclude_hosp': 'same_county_pcp',
            'npi_count_without_low_include_hosp': 'pcp_npi_count_without_low_include_hosp',
            'npi_count_with_low_include_hosp': 'pcp_npi_count_with_low_include_hosp',
            'npi_count_without_low_exclude_hosp': 'pcp_npi_count_without_low_exclude_hosp'},
    'Physician Specialists': {'npi_count_with_low_exclude_hosp': 'same_county_specialist',
                              'npi_count_without_low_include_hosp': 'spe_npi_count_without_low_include_hosp',
                              'npi_count_with_low_include_hosp': 'spe_npi_count_with_low_include_hosp',
                              'npi_count_without_low_exclude_hosp': 'spe_npi_count_without_low_exclude_hosp'},
    'Other Providers': {'npi_count_with_low_exclude_hosp': 'same_county_nonphyspec',
                        'npi_count_without_low_include_hosp': 'other_npi_count_without_low_include_hosp',
                        'npi_count_with_low_include_hosp': 'other_npi_count_with_low_include_hosp',
                        'npi_count_without_low_exclude_hosp': 'other_npi_count_without_low_exclude_hosp'},
}

# Stage1 settings
RATING_COLS = ['MA Utilization Score category', 'FFS Utilization Score category', 'Cost Score rating',
               'Quality Score rating', 'PU Score rating']
HIGH_COLS = sorted(RATING_COLS)   # Stage1 unstack order
PCT_METRICS = [
    ('MA Utilization Score',  'category'),
    ('FFS Utilization Score', 'category'),
    ('Cost Score',            'rating'),
    ('Quality Score',         'rating'),
    ('PU Score',              'rating')
]

# Stage2 settings
MBV_STATE_COL = 'Missing by virtue of data not being there'
COUNTY_MBV_COLS = ['Hospital_Data_Missing_Flag', 'PCP_Flag', 'Specialist_Flag', 'Missing by Virtue']
HWAI_COLS = ['Contract_id', 'Modified Hwai Rating', 'SNP_Type', 'imputedAt', 'count',
             'Modified Hwai Rating_old', 'countRatings', 'Modified Hwai Rating_scaled']
COUNT_FEATURES = ['Hospital Score', 'Specialist Score', 'PCP Score']   # normalisation order
SC_SAME_COUNTY = ['same_county_pcp', 'same_county_specialist', 'same_county_hospital']
MISSING_CASES = [
    ("Hospital Data Missing", ["Hospital Score"]),
    ("PCP Data Missing", ["PCP Score"]),
    ("Specialist Data Missing", ["Specialist Score"]),
    ("Hospital and Specialist Data Missing", ["Hospital Score", "Specialist Score"]),
    ("PCP and Specialist Data Missing", ["PCP Score", "Specialist Score"]),
    ("Hospital and PCP Data Missing", ["Hospital Score", "PCP Score"]),
    ("Specialist and PCP Data Missing", ["Specialist Score", "PCP Score"])
]
PLAN_TYPE_CLEAN = {'Local PPO *': 'Local PPO', 'HMO *': 'HMO', 'HMO-POS *': 'HMO-POS',
                   'Regional PPO *': 'Regional PPO', 'MSA *': 'MSA', 'PFFS *': 'PFFS', 'Cost *': 'Cost'}

# Output file names (all in LOOKUP_DIR)
LK_FILES = {
    'phy_rows':    'lk_phy_rows.csv',
    'sc_phy':      'lk_sc_phy_base.csv',
    'hosp_rows':   'lk_hosp_rows.csv',
    'sc_hosp':     'lk_sc_hosp_base.csv',
    's1_pcp':      'lk_s1_pcp.csv',
    's1_spe':      'lk_s1_spe.csv',
    's1_hosp':     'lk_s1_hosp.csv',
    'mkt_pcp':     'lk_mkt_pcp.csv',
    'mkt_spe':     'lk_mkt_spe.csv',
    'mkt_hosp':    'lk_mkt_hosp.csv',
    'hash_counts': 'lk_hash_counts.csv',
    'mbv_county':  'lk_mbv_county.csv',
    'weights':     'lk_weights.csv',
    'plan_rows':   'lk_plan_rows.csv',
}
BASE_FINAL_FILE = 'base_final.csv'     # Stage2 output equivalent (no drop)
BASE_RANKED_FILE = 'base_ranked.csv'   # Stage3 output equivalent (no drop) = current ranks

########################################## Loading ##########################################
_LK = {}


def _to_int(df, cols):
    for c in cols:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors='coerce')
            df.dropna(subset=[c], inplace=True)
            df[c] = df[c].astype('int64')
    return df


def _to_float(df, cols):
    for c in cols:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors='coerce')
    return df


def load_lookups(force=False):
    """Load all Stage1_static lookups once per session (cached)."""
    if _LK and not force:
        return _LK
    _LK.clear()
    for k, f in LK_FILES.items():
        _LK[k] = pd.read_csv(LOOKUP_DIR + f, low_memory=False)

    for k in ['phy_rows', 'sc_phy', 'hosp_rows', 'sc_hosp', 's1_pcp', 's1_spe', 's1_hosp', 'mbv_county']:
        _to_int(_LK[k], [FIPS, 'network_id'])
    for k in ['mkt_pcp', 'mkt_spe', 'mkt_hosp', 'hash_counts']:
        _to_int(_LK[k], [FIPS])
    for k in ['phy_rows', 's1_pcp', 's1_spe']:
        _to_float(_LK[k], ['npi'])
    _to_float(_LK['hosp_rows'], ['hosp_npi'])
    _to_float(_LK['s1_hosp'], ['hosp_npi', 'Cost Score', 'Quality Score'])
    _LK['s1_hosp']['npi'] = _LK['s1_hosp']['npi'].astype(str)

    P = _LK['plan_rows']
    P[FIPS] = pd.to_numeric(P[FIPS], errors='coerce').astype('int64')
    P['network_id'] = pd.to_numeric(P['network_id'], errors='coerce')

    # landscape (state, FIPS, network) pairs used for count normalisation
    pairs = P[P['network_id'].notna()][['state', FIPS, 'network_id']].drop_duplicates().copy()
    pairs['network_id'] = pairs['network_id'].astype('int64')
    _LK['lsc_pairs'] = pairs

    # network selection table (Stage0 network_id_list)
    sc = P[['Parent_Organization', 'Plan_Type', 'Bid_ID', 'network_id']].dropna(subset=['network_id']).copy()
    sc['Plan_Type'] = sc['Plan_Type'].replace(PLAN_MAP)
    sc['Plan_ID'] = sc['Bid_ID'].astype(str).str.rsplit('_', n=1).str[0]
    sc['network_id'] = sc['network_id'].astype('int64')
    _LK['scope'] = sc.drop_duplicates()

    # column groups of the plan rows (used to keep the Stage2 column order)
    cols = P.columns.tolist()
    i_cf, i_hw = cols.index('plan_cf'), cols.index('Contract_id')
    _LK['lsc_cols'] = cols[:i_cf]
    _LK['mid_cols'] = cols[i_cf:i_hw]
    _LK['weight_cols'] = [c for c in _LK['weights'].columns if c != 'Category']

    # networks with no physician row data (no Ind_network_file): their Stage1 values stay at baseline
    _LK['frozen_nets'] = set(sc['network_id'].unique()) - set(_LK['phy_rows']['network_id'].unique())
    print('Lookups loaded from', LOOKUP_DIR, '| networks kept at baseline Stage1 values:', len(_LK['frozen_nets']))
    return _LK


def _load_base():
    L = load_lookups()
    if 'base_final' not in L:
        L['base_final'] = pd.read_csv(LOOKUP_DIR + BASE_FINAL_FILE, low_memory=False)
        L['base_ranked'] = pd.read_csv(LOOKUP_DIR + BASE_RANKED_FILE, low_memory=False)
    return L

########################################## Helpers ##########################################


def _as_list(x):
    if x is None:
        return None
    if isinstance(x, (list, tuple, set)):
        return list(x)
    return [x]


def network_id_list(payor=None, plan_type=None, plan_id=None):
    """Networks of a payor x plan type x plan id scope (Stage0_1 / Stage0_2 logic)."""
    sc = load_lookups()['scope']
    if payor:
        sc = sc[sc['Parent_Organization'].isin(_as_list(payor))]
    if plan_type:
        sc = sc[sc['Plan_Type'].isin(_as_list(plan_type))]
    if plan_id:
        sc = sc[sc['Plan_ID'].isin(_as_list(plan_id))]
    return sc['network_id'].unique().tolist()


def _pair_mask(df, pairs):
    """True where df's (FIPS, network_id) is in pairs."""
    if pairs.empty or df.empty:
        return np.zeros(len(df), dtype=bool)
    idx = pd.MultiIndex.from_frame(pairs[[FIPS, 'network_id']].astype('int64'))
    return pd.MultiIndex.from_frame(df[[FIPS, 'network_id']].astype('int64')).isin(idx)


def _anti_join(df, gone, on):
    """Rows of df not matching gone on the given columns."""
    if gone.empty or df.empty:
        return df
    m = df[on].merge(gone[on].drop_duplicates().assign(_gone=1), on=on, how='left')
    return df[m['_gone'].isna().values]


def _empty(int_cols, float_cols=()):
    d = {c: pd.Series(dtype='int64') for c in int_cols}
    d.update({c: pd.Series(dtype='float64') for c in float_cols})
    return pd.DataFrame(d)

################################ Stage0 logic: s_c recounts ################################


def _recount_phy(rows):
    """Stage0_2 four s_c counts on the remaining physician rows."""
    rows = rows[~rows['excluded']]
    if rows.empty:
        return pd.DataFrame(columns=PHY_KEYS + SC_COUNTS + ['data_source_type'])

    def sc_count(data, confidence, name):
        return (
            data[data['location_confidence'].isin(confidence)]
            .groupby(PHY_KEYS, sort=False)['npi'].nunique()
            .rename(name).reset_index()
        )

    a = sc_count(rows, HML, SC_COUNTS[0])
    b = sc_count(rows, HM, SC_COUNTS[1])
    non_hosp = rows[rows['non_hosp']]
    c = sc_count(non_hosp, HML, SC_COUNTS[2])
    d = sc_count(non_hosp, HM, SC_COUNTS[3])

    result = a.merge(b, on=PHY_KEYS, how='outer')
    result = result.merge(c, on=PHY_KEYS, how='outer')
    result = result.merge(d, on=PHY_KEYS, how='outer')
    result['data_source_type'] = np.where(result['network_id'].isin(MEDICARE_NETS),
                                          'Medicare/Medicaid/Supply', 'Vericred/Client Data')
    return result


def _recount_hosp(rows):
    """Stage0_1 hospital s_c count on the remaining hospital rows."""
    return (rows.groupby(['state', 'county_name', FIPS, 'network_id', 'New Flag'], sort=False)['hosp_key']
            .nunique().reset_index().rename(columns={'hosp_key': 'same_county_count'}))


def _hosp_sum(sc_hosp):
    """Stage2: hospital s_c count summed over New Flag."""
    return (sc_hosp.drop_duplicates()
            .groupby(['state', FIPS, 'network_id'], as_index=False)
            .agg({'same_county_count': 'sum'})
            .rename(columns={'same_county_count': 'same_county_hospital'}))

################################# Stage1 logic: high counts #################################


def _high_counts(df, prefix):
    keys = [FIPS, 'network_id']
    out_cols = [prefix + c for c in HIGH_COLS]
    if df.empty:
        return _empty(keys, out_cols)
    long = df.melt(id_vars=keys + ['npi'], value_vars=RATING_COLS, var_name='metric', value_name='rating')
    long = long[long['rating'] == 'High']
    if long.empty:
        return _empty(keys, out_cols)
    out = long.groupby(keys + ['metric'])['npi'].nunique().unstack('metric')
    out = out.reindex(columns=HIGH_COLS).reset_index()
    out.columns.name = None
    return out.rename(columns={c: prefix + c for c in HIGH_COLS})


def _stage1(s1_pcp, s1_spe, s1_hosp, fips):
    """Stage1.py for the given counties -> (high_score_percent rows, network_popularity rows)."""
    L = load_lookups()
    k3 = ['state', FIPS, 'network_id']
    keys = [FIPS, 'network_id']
    pcp = s1_pcp[s1_pcp[FIPS].isin(fips)]
    spe = s1_spe[s1_spe[FIPS].isin(fips)]
    hosp = s1_hosp[s1_hosp[FIPS].isin(fips)].copy()

    # PU based counts (network_popularity_v3)
    temp_df_pcp = (pcp[pcp['PU Score'] < 2].groupby(k3, as_index=False).agg({'npi': 'nunique'})
                   .rename(columns={'npi': 'count_npi_pcp_less_than_2'}))
    temp_df = (pcp.groupby(k3, as_index=False).agg({'npi': 'nunique'})
               .rename(columns={'npi': 'count_npi_total_pcp'}))
    temp_df = temp_df.merge(temp_df_pcp, on=k3, how='left')
    temp_df['count_npi_pcp_percent'] = (temp_df['count_npi_pcp_less_than_2'] / temp_df['count_npi_total_pcp']) * 100

    temp_df_spe = (spe[spe['PU Score'] < 2.5].groupby(k3, as_index=False).agg({'npi': 'nunique'})
                   .rename(columns={'npi': 'count_npi_spe_less_than_2.5'}))
    temp_df2 = (spe.groupby(k3, as_index=False).agg({'npi': 'nunique'})
                .rename(columns={'npi': 'count_npi_total_spe'}))
    temp_df2 = temp_df2.merge(temp_df_spe, on=k3, how='left')
    temp_df2['count_npi_spe_percent'] = (temp_df2['count_npi_spe_less_than_2.5'] / temp_df2['count_npi_total_spe']) * 100

    joined_df = temp_df.merge(temp_df2, on=k3, how='outer')
    for c in ['count_npi_pcp_less_than_2', 'count_npi_spe_less_than_2.5', 'count_npi_total_pcp', 'count_npi_total_spe']:
        joined_df[c] = joined_df[c].fillna(0)
    joined_df['pcp+spe percent'] = ((joined_df['count_npi_pcp_less_than_2'] + joined_df['count_npi_spe_less_than_2.5']) /
                                    (joined_df['count_npi_total_pcp'] + joined_df['count_npi_total_spe'])) * 100
    clean_df = joined_df.merge(L['hash_counts'], on=['state', FIPS], how='left')

    # Hospital Cost / Quality rating: 4-5 or equal to the county max of the remaining rows
    for s in ['Cost Score', 'Quality Score']:
        hosp[s + ' max'] = hosp.groupby(FIPS)[s].transform('max')
        hosp[s + ' rating'] = np.where(hosp[s].isin([4, 5]) | (hosp[s] == hosp[s + ' max']), 'High', 'Not Available')

    final_df = _high_counts(pcp, 'PCP_')
    final_df1 = _high_counts(spe, 'Spe_')
    final_df2 = _high_counts(hosp, 'Hosp_')

    merged_df = pd.merge(final_df, final_df1, on=keys, how='outer')
    merged_df = pd.merge(merged_df, final_df2, on=keys, how='outer')
    agg_cols = [c for c in merged_df.columns if c.startswith("PCP_") or c.startswith("Spe_") or c.startswith("Hosp_")]
    merged_df[agg_cols] = merged_df[agg_cols].fillna(0)

    for m in ['mkt_spe', 'mkt_pcp', 'mkt_hosp']:
        mk = L[m][L[m][FIPS].isin(fips)]
        merged_df = pd.merge(merged_df, mk, on=[FIPS], how='outer')
    merged_df[agg_cols] = merged_df[agg_cols].fillna(0)

    for prefix in ["PCP_", "Spe_", "Hosp_"]:
        for metric, suffix in PCT_METRICS:
            cat_col = f"{prefix}{metric} {suffix}"
            market_col = f"{prefix}market_{metric}"
            if cat_col in merged_df.columns and market_col in merged_df.columns:
                merged_df[f"{prefix}{metric} %"] = (merged_df[cat_col].astype(float) /
                                                    merged_df[market_col].astype(float)) * 100
    return merged_df, clean_df

############################### Stage2 logic: count normalisation ###############################


def binary_normalization(series):
    return series * 100


def min_max_normalization(series):
    min_val, max_val = series.min(), series.max()
    if min_val == max_val:
        return pd.Series(100 if min_val != 0 else 0, index=series.index)
    if min_val > 0:
        return (series - min_val) / (max_val - min_val) * 99 + 1
    else:
        return (series - min_val) / (max_val - min_val) * 100


def log_normalization(series):
    if (series <= 0).any():
        return min_max_normalization(series)
    transformed = np.log1p(series)
    min_val, max_val = transformed.min(), transformed.max()
    if min_val == max_val:
        return pd.Series(100 if min_val != 0 else 0, index=series.index)
    if series.min() > 0:
        return (transformed - min_val) / (max_val - min_val) * 99 + 1
    else:
        return (transformed - min_val) / (max_val - min_val) * 100


def z_score_normalization(series):
    if (series <= 0).any():
        return min_max_normalization(series)
    if series.nunique() == 1:
        return pd.Series(100 if series.iloc[0] != 0 else 0, index=series.index)
    z_normalized = (series - series.mean()) / series.std()
    min_val, max_val = z_normalized.min(), z_normalized.max()
    if min_val == max_val:
        return pd.Series(100 if min_val != 0 else 0, index=series.index)
    if series.min() > 0:
        return (z_normalized - min_val) / (max_val - min_val) * 99 + 1
    else:
        return (z_normalized - min_val) / (max_val - min_val) * 100


def analyze_and_normalize(data, feature_list):
    """Stage2 normalisation per FIPS (method picked by distribution of each county)."""
    parts = []
    for _, group in data.groupby(FIPS, sort=False):
        group = group.copy()
        for feature in feature_list:
            series = group[feature]
            if series.nunique() == 2 and set(series.unique()).issubset({0, 1}):
                group[feature + '_scaled'] = binary_normalization(series)
            elif (series > 0).all() and (series.skew() > 1 or series.skew() < -1):
                group[feature + '_scaled'] = log_normalization(series)
            elif abs(series.skew()) < 1:
                if (series <= 0).any():
                    group[feature + '_scaled'] = min_max_normalization(series)
                else:
                    group[feature + '_scaled'] = z_score_normalization(series)
            else:
                group[feature + '_scaled'] = min_max_normalization(series)
        parts.append(group)
    if not parts:
        return data.assign(**{f + '_scaled': np.nan for f in feature_list})
    return pd.concat(parts)


def _count_scores(sc_phy, sc_hosp, fips):
    """Stage2 first block: s_c counts on landscape pairs, MBV zeroing, normalisation."""
    L = load_lookups()
    k3 = ['state', FIPS, 'network_id']
    pairs = L['lsc_pairs'][L['lsc_pairs'][FIPS].isin(fips)]

    def phy(flag, new_name):
        t = sc_phy[sc_phy['New Flag'] == flag].drop(columns=['New Flag']).drop_duplicates()
        t = t[t['data_source_type'] == 'Vericred/Client Data']
        return t[k3 + ['npi_count_with_low_exclude_hosp']].rename(columns={'npi_count_with_low_exclude_hosp': new_name})

    df = pairs.merge(phy('PCP', 'PCP Score'), how='left', on=k3)
    df = df.merge(_hosp_sum(sc_hosp).rename(columns={'same_county_hospital': 'Hospital Score'}), how='left', on=k3)
    df = df.merge(phy('Physician Specialists', 'Specialist Score'), how='left', on=k3)
    for c in ['PCP Score', 'Specialist Score', 'Hospital Score']:
        df[c] = df[c].fillna(0)
    df = df.groupby([FIPS, 'network_id'], as_index=False)[['PCP Score', 'Specialist Score', 'Hospital Score']].sum()

    df = df.merge(L['mbv_county'][[FIPS, 'network_id', 'Missing by Virtue']], on=[FIPS, 'network_id'], how='left')
    df.loc[df['Missing by Virtue'] == 'Y', COUNT_FEATURES] = 0
    for case, columns_to_zero in MISSING_CASES:
        df.loc[df['Missing by Virtue'] == case, columns_to_zero] = 0
    df.drop(columns=['Missing by Virtue'], inplace=True)

    return analyze_and_normalize(df, COUNT_FEATURES)

################################ Stage2 logic: plan level score ################################


def _assemble(sc_phy, sc_hosp, scaled_df, clean_df, fips):
    """Stage2 second / third block for the given counties -> final table rows (unranked)."""
    L = load_lookups()
    df = L['plan_rows'][L['plan_rows'][FIPS].isin(fips)].copy()
    df['_net'] = df['network_id'].fillna(0).astype('int64')
    k3n = ['state', FIPS, '_net']
    added = []

    def add(df, right, on):
        right = right.rename(columns={'network_id': '_net'})
        added.extend([c for c in right.columns if c not in on and c not in df.columns])
        return df.merge(right, how='left', on=on)

    # s_c counts (merge order as in Stage2: PCP, hospital, specialist, other providers)
    sc = sc_phy[sc_phy[FIPS].isin(fips)]
    hs = sc_hosp[sc_hosp[FIPS].isin(fips)]
    df = add(df, _phy_frame(sc, 'PCP'), k3n)
    df = add(df, _hosp_sum(hs), k3n)
    df = add(df, _phy_frame(sc, 'Physician Specialists'), k3n)
    df = add(df, _phy_frame(sc, 'Other Providers'), k3n)
    df = add(df, scaled_df.drop(columns=['state'], errors='ignore'), [FIPS, '_net'])
    df = add(df, clean_df, k3n)

    # Category + weights
    pct = df['pcp+spe percent']
    hmo = df['plan_cf'] == 'HMO'
    df['Category'] = np.select(
        [~hmo, hmo & (pct >= 85), hmo & (pct < 85) & (pct >= 50), hmo & (pct < 50), hmo & pct.isnull()],
        ['plan not HMO', 'HMO Highly Closed', 'HMO Medium Closed', 'HMO Open', 'HMO Open'],
        default='')
    df['Category'] = df['Category'].replace('', np.nan)
    df = df.merge(L['weights'], on=['Category'], how='left')

    # pro_score
    cols = ['PCP Score_scaled', 'Specialist Score_scaled', 'Hospital Score_scaled', 'PCP_PU Score %', 'Spe_PU Score %',
            'Hosp_PU Score %', 'PCP_Quality Score %', 'Spe_Quality Score %', 'Hosp_Quality Score %']
    for c in cols:
        if c not in df.columns:
            df[c] = np.nan
    df[cols] = df[cols].fillna(0)
    df[cols] = df[cols].replace(np.inf, 0)
    df['pro_score'] = (((df['PCP Score_scaled'] * df['PCP Count weightage']) +
                        (df['Specialist Score_scaled'] * df['Specialist Count weightage']) +
                        (df['Hospital Score_scaled'] * df['Hospital Count weightage'])) +
                       ((df['PCP_PU Score %'] * df['Pop PCP_Weightage']) +
                        (df['Spe_PU Score %'] * df['Pop Spe_Weightage']) +
                        (df['Hosp_PU Score %'] * df['Pop Hosp Weightage'])) +
                       ((df['PCP_Quality Score %'] * df['PCP Quality Score Weightage']) +
                        (df['Spe_Quality Score %'] * df['Specialist Quality Score Weightage']) +
                        (df['Hosp_Quality Score %'] * df['Hospital Quality Score Weightage'])))

    # HWAI blend (70 / 30)
    hw = df['Modified Hwai Rating_scaled'].fillna(0)
    df['pro_score_rating_70_30'] = np.where(hw > 0, df['pro_score'] + hw * 0.30, df['pro_score'] * 100 / 70)

    # state level MBV rules on same county counts
    mbv = df[MBV_STATE_COL].fillna('N')
    for c in SC_SAME_COUNTY:
        df.loc[mbv == 'Y', c] = np.nan
        df.loc[(mbv == 'N') & df[c].isnull(), c] = 0
    for c in ['same_county_pcp', 'same_county_specialist']:
        df.loc[(mbv == 'Hospital Data Missing') & df[c].isnull(), c] = 0
    df.loc[mbv == 'Hospital Data Missing', 'same_county_hospital'] = np.nan
    all_blank = df[SC_SAME_COUNTY].isnull().all(axis=1)
    df.loc[all_blank, ['pro_score', 'pro_score_rating_70_30']] = np.nan

    # 15-85 scaling per FIPS
    f = 'pro_score_rating_70_30'
    mx = df.groupby(FIPS)[f].transform('max')
    mn = df.groupby(FIPS)[f].transform('min')
    with np.errstate(divide='ignore', invalid='ignore'):
        scaled = ((df[f] - mn) * 70 / (mx - mn)) + 15
    scaled = np.where((mx == 15) & (mn == 15), 15, scaled)
    scaled = np.where((mx == mn) & (mn != 15), 85, scaled)
    df[f + '_scaled'] = scaled
    df.loc[all_blank, f + '_scaled'] = np.nan

    df['Plan_Type'] = df['Plan_Type'].replace(PLAN_TYPE_CLEAN)
    df.rename(columns={'pro_score': 'pro_score_old', 'pro_score_rating_70_30': 'pro_score_notscaled',
                       'pro_score_rating_70_30_scaled': 'pro_score'}, inplace=True)

    # county level MBV flags
    mapping = L['mbv_county'][['State', 'county_name', 'network_id', FIPS] + COUNTY_MBV_COLS].drop_duplicates()
    null = df[df['network_id'].isna()]
    rest = df[df['network_id'].notna()].copy()
    rest['network_id'] = rest['network_id'].astype('int64')
    rest = rest.merge(mapping, on=['State', 'county_name', 'network_id', FIPS], how='left')
    df = pd.concat([rest, null], ignore_index=True)

    # Stage2 column order
    order = (L['lsc_cols'] + added + L['mid_cols'] + ['Category'] + L['weight_cols'] + ['pro_score_old'] +
             HWAI_COLS + ['pro_score_notscaled', MBV_STATE_COL, 'pro_score'] + COUNTY_MBV_COLS)
    order = [c for c in dict.fromkeys(order) if c in df.columns]
    return df[order]


def _phy_frame(sc_phy, flag):
    t = sc_phy[sc_phy['New Flag'] == flag].drop(columns=['New Flag', 'county_name', 'data_source_type'], errors='ignore')
    return t.rename(columns=PHY_FLAG_RENAME[flag]).drop_duplicates()

#################################### Stage3 logic: ranks ####################################


def rank_table(final):
    """Stage3.py: HMO / PPO filter, PlanID, enrollment weighted ranks."""
    df = final.copy()
    df["Plan_Type"] = df["Plan_Type"].str.strip()
    df = df[df["Plan_Type"].isin(PLAN_TYPE_RULES.keys())].reset_index(drop=True)
    df["Plan_Type"] = df["Plan_Type"].map(PLAN_TYPE_RULES)
    df = df.rename(columns={"pro_score": "network_score"})

    bid_parts = df["Bid_ID"].astype(str).str.strip().str.split("_")
    df.insert(df.columns.get_loc("Bid_ID") + 1, "PlanID", bid_parts.str[0] + "_" + bid_parts.str[1])

    df["_w"] = df[ENROLLMENT_COL].fillna(0).where(df["network_score"].notna(), 0)
    df["_ws"] = df["_w"] * df["network_score"].fillna(0)

    for rank_col, keys in RANK_LEVELS.items():
        grp = df.groupby(RANK_SCOPE + keys, as_index=False).agg(_w=("_w", "sum"), _ws=("_ws", "sum"), _mean=("network_score", "mean"))
        grp["_score"] = (grp["_ws"] / grp["_w"]).where(grp["_w"] > 0, grp["_mean"])   # no enrollment -> simple mean
        if RANK_SCOPE:
            grp[rank_col] = grp.groupby(RANK_SCOPE)["_score"].rank(ascending=False, method="min").astype("Int64")
        else:
            grp[rank_col] = grp["_score"].rank(ascending=False, method="min").astype("Int64")
        df = df.merge(grp[RANK_SCOPE + keys + [rank_col]], on=RANK_SCOPE + keys, how="left")

    return df.drop(columns=["_w", "_ws"])

def _freeze_stage1(npi_score, clean_df, fips):
    """Networks without physician row data keep their baseline Stage1 values (high counts, %,
    PU based counts, pcp+spe percent) instead of being recomputed as zero."""
    L = _load_base()
    nets = L['frozen_nets']
    b = L['base_final']
    b = b[b[FIPS].isin(fips) & b['network_id'].isin(nets)]
    if b.empty:
        return npi_score, clean_df
    keys = [FIPS, 'network_id']

    s1_cols = [c for c in npi_score.columns if c not in keys and c in b.columns]
    frozen = b[keys + s1_cols].drop_duplicates(subset=keys)
    npi_score = pd.concat([npi_score[~npi_score['network_id'].isin(nets)], frozen], ignore_index=True)

    clean_cols = [c for c in clean_df.columns if c not in ['state'] + keys and c in b.columns]
    frozen = b[['state'] + keys + clean_cols].drop_duplicates(subset=keys)
    clean_df = pd.concat([clean_df[~clean_df['network_id'].isin(nets)], frozen], ignore_index=True)
    return npi_score, clean_df


###################################### Main entry points ######################################


def build_final(sc_phy, sc_hosp, s1_pcp, s1_spe, s1_hosp, fips):
    """Full chain for the given counties -> final table rows (unranked)."""
    fips = list(fips)
    npi_score, clean_df = _stage1(s1_pcp, s1_spe, s1_hosp, fips)
    npi_score, clean_df = _freeze_stage1(npi_score, clean_df, fips)
    mjhs_submarket = _count_scores(sc_phy, sc_hosp, fips)
    scaled_df = npi_score.merge(mjhs_submarket, how='right', on=[FIPS, 'network_id'])
    scaled_df[FIPS] = scaled_df[FIPS].astype('int64')
    scaled_df['network_id'] = scaled_df['network_id'].astype('int64')
    return _assemble(sc_phy, sc_hosp, scaled_df, clean_df, fips)


def build_baseline():
    """No drop run over all counties. Writes base_final.csv and base_ranked.csv."""
    L = load_lookups()
    fips = L['plan_rows'][FIPS].unique()
    final = build_final(L['sc_phy'], L['sc_hosp'], L['s1_pcp'], L['s1_spe'], L['s1_hosp'], fips)
    ranked = rank_table(final)
    final.to_csv(LOOKUP_DIR + BASE_FINAL_FILE, index=False)
    ranked.to_csv(LOOKUP_DIR + BASE_RANKED_FILE, index=False)
    L.pop('base_final', None)
    L.pop('base_ranked', None)
    print('Baseline written:', BASE_FINAL_FILE, final.shape, '|', BASE_RANKED_FILE, ranked.shape)
    return ranked


def apply_drops(drops):
    """Remove the dropped items from the row level data and rebuild the affected s_c counts.

    Returns (sc_phy, sc_hosp, s1_pcp, s1_spe, s1_hosp, affected_fips).
    """
    L = load_lookups()
    phy, hosp = L['phy_rows'], L['hosp_rows']
    phy_drop = np.zeros(len(phy), dtype=bool)
    hosp_drop = np.zeros(len(hosp), dtype=bool)

    for d in drops:
        kind = str(d.get('type', '')).strip().lower()
        names = _as_list(d.get('name'))
        if not names:
            raise ValueError(f"Drop {d} has no 'name'")
        nets =network_id_list(d.get('payor'), d.get('plan_type'), d.get('plan_id'))
        print(f"Drop {kind} {names}: {len(nets)} networks in scope")
        if kind in ('group', 'physician_group'):
            phy_drop |= (phy['network_id'].isin(nets) & phy['group_name'].isin(names)).values
        elif kind in ('health_system', 'hospital'):
            hosp_drop |= (hosp['network_id'].isin(nets) & hosp['Health System'].isin(names)).values
        else:
            raise ValueError(f"Unknown drop type '{d.get('type')}' - use 'health_system' or 'group'")

    removed_phy, kept_phy = phy[phy_drop], phy[~phy_drop]
    removed_hosp, kept_hosp = hosp[hosp_drop], hosp[~hosp_drop]
    phy_pairs = removed_phy[[FIPS, 'network_id']].drop_duplicates()
    hosp_pairs = removed_hosp[[FIPS, 'network_id']].drop_duplicates()

    # s_c physician counts: recount affected network x county pairs (pair with no rows left -> no counts)
    sc_phy = L['sc_phy'][~_pair_mask(L['sc_phy'], phy_pairs)]
    recount = _recount_phy(kept_phy[_pair_mask(kept_phy, phy_pairs)])
    if len(recount):
        sc_phy = pd.concat([sc_phy, recount], ignore_index=True)

    # s_c hospital counts (pair with no rows left -> no counts)
    sc_hosp = L['sc_hosp'][~_pair_mask(L['sc_hosp'], hosp_pairs)]
    recount = _recount_hosp(kept_hosp[_pair_mask(kept_hosp, hosp_pairs)])
    if len(recount):
        sc_hosp = pd.concat([sc_hosp, recount], ignore_index=True)

    # Stage1 physicians: npi leaves a network x county only if no row is left under another group
    k = ['npi', FIPS, 'network_id']
    gone = removed_phy[k].drop_duplicates()
    gone = _anti_join(gone, kept_phy[k].drop_duplicates(), k)
    s1_pcp = _anti_join(L['s1_pcp'], gone, k)
    s1_spe = _anti_join(L['s1_spe'], gone, k)

    # Stage1 hospitals: matched on npi + address + county + network (no specialty)
    kh = ['hosp_npi', 'Address First Line', FIPS, 'network_id']
    s1_hosp = _anti_join(L['s1_hosp'], removed_hosp[kh].drop_duplicates(), kh)

    plan_fips = set(L['plan_rows'][FIPS].unique())
    fips = sorted((set(phy_pairs[FIPS]) | set(hosp_pairs[FIPS])) & plan_fips)
    print(f"Rows removed - physician: {len(removed_phy)}, hospital: {len(removed_hosp)} | counties affected: {len(fips)}")
    return sc_phy, sc_hosp, s1_pcp, s1_spe, s1_hosp, fips


def run_scenario(drops, output_file=None):
    """Drop the given items and return the ranked final table (same layout as Stage3 output).

    drops: list of dicts, each {'type': 'health_system' | 'group', 'name': str or list,
                                'payor': str/list/None, 'plan_type': str/list/None, 'plan_id': str/list/None}
    """
    L = _load_base()
    if not drops:
        return L['base_ranked'].copy()

    sc_phy, sc_hosp, s1_pcp, s1_spe, s1_hosp, fips = apply_drops(drops)
    if not fips:
        print('Nothing was removed in the landscape counties - baseline ranks returned')
        ranked = L['base_ranked'].copy()
        ranked.attrs['affected_fips'] = []
        return ranked

    new_rows = build_final(sc_phy, sc_hosp, s1_pcp, s1_spe, s1_hosp, fips)
    base = L['base_final']
    final = pd.concat([base[~base[FIPS].isin(fips)], new_rows], ignore_index=True)
    final = final[[c for c in base.columns if c in final.columns] + [c for c in final.columns if c not in base.columns]]
    ranked = rank_table(final)
    ranked.attrs['affected_fips'] = fips

    if output_file:
        ranked.to_csv(output_file, index=False)
        print('Saved', output_file)
    return ranked


def rank_view(ranked, payor=None, plan_type=None, plan_id=None, county=None):
    """Ranks of a payor x plan type x plan id (optionally one county) from a ranked table."""
    m = pd.Series(True, index=ranked.index)
    if payor:
        m &= ranked[PAYOR_COL].isin(_as_list(payor))
    if plan_type:
        m &= ranked['Plan_Type'].isin(_as_list(plan_type))
    if plan_id:
        m &= ranked['PlanID'].isin(_as_list(plan_id))
    if county:
        m &= ranked['county_name'].isin(_as_list(county))
    cols = ['state', 'county_name', FIPS, PAYOR_COL, 'Plan_Type', 'PlanID',
            'rank_payor_plantype_planid', 'rank_payor_plantype', 'rank_payor']
    return ranked.loc[m, cols].drop_duplicates().sort_values(['state', 'county_name', 'rank_payor_plantype_planid'])


def current_rank(payor=None, plan_type=None, plan_id=None, county=None):
    """Current (no drop) ranks - lookup only."""
    return rank_view(_load_base()['base_ranked'], payor, plan_type, plan_id, county)


###################################### Command line ######################################
import json
import sys


def _blank(value):
    text = '' if value is None else str(value).strip()
    return text or None


def _increase_flag(value):
    text = '' if value is None else str(value).strip().lower()
    if text == '':
        return None
    if text in ('true', '1', 'yes', 'add', 'increase'):
        return True
    if text in ('false', '0', 'no', 'remove', 'drop', 'terminate'):
        return False
    raise ValueError("increase flags must be true (added) or false (removed)")


def _scope_error(payor, plan_type, plan_id):
    if plan_type and not payor:
        return 'A plan type cannot be passed on its own. Pass a payor, a plan id, or a payor and plan type.'
    if not payor and not plan_id:
        return 'Pass a payor, a plan id, or a payor and plan type. A plan type alone is not a scope.'
    return ''


def _rank_column(payor, plan_type, plan_id):
    if plan_id:
        return 'rank_payor_plantype_planid'
    if payor and plan_type:
        return 'rank_payor_plantype'
    return 'rank_payor'


def _json_cell(value):
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except TypeError:
        pass
    if hasattr(value, 'item'):
        try:
            value = value.item()
        except Exception:
            return str(value)
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _rows_payload(before, after, rank_col):
    keys = ['state', 'county_name', PAYOR_COL, 'Plan_Type', 'PlanID']
    right = before[keys + [rank_col]].rename(columns={rank_col: '_before'})
    merged = after.merge(right, on=keys, how='left')
    rows = []
    for _, row in merged.iterrows():
        rows.append({
            'state': _json_cell(row.get('state')),
            'county': _json_cell(row.get('county_name')),
            'payor': _json_cell(row.get(PAYOR_COL)),
            'planType': _json_cell(row.get('Plan_Type')),
            'planId': _json_cell(row.get('PlanID')),
            'rank': _json_cell(row.get(rank_col)),
            'rankBefore': _json_cell(row.get('_before')),
            'rank_payor': _json_cell(row.get('rank_payor')),
            'rank_payor_plantype': _json_cell(row.get('rank_payor_plantype')),
            'rank_payor_plantype_planid': _json_cell(row.get('rank_payor_plantype_planid')),
        })
    return rows


def _county_ranks(before, after, counties):
    """Every payor x plan type in the given counties: rank before and after (rank_payor_plantype)."""
    keys = ['county_name', PAYOR_COL, 'Plan_Type']
    col = 'rank_payor_plantype'

    def collapse(frame):
        part = frame[frame['county_name'].isin(counties)][keys + [col]].dropna(subset=[col])
        return part.drop_duplicates(subset=keys)

    merged = collapse(after).merge(collapse(before).rename(columns={col: '_before'}), on=keys, how='left')
    merged = merged.sort_values(['county_name', col, 'Plan_Type', PAYOR_COL])
    return [{
        'county': _json_cell(row['county_name']),
        'payor': _json_cell(row[PAYOR_COL]),
        'planType': _json_cell(row['Plan_Type']),
        'rank': _json_cell(row[col]),
        'rankBefore': _json_cell(row['_before']),
    } for _, row in merged.iterrows()]


# Measures the chatbot shows to explain a rank move, enrollment weighted per county x payor x plan type.
EXPLAIN_MEASURES = {
    'hospitals': '# of Hospitals',
    'highQualityHospitals': 'Hosp_Quality Score rating',
    'hospitalQualityPct': 'Hosp_Quality Score %',
    'pcps': '# of PCP',
    'specialists': '# of Specialist',
    'pcpQualityPct': 'PCP_Quality Score %',
    'specialistQualityPct': 'Spe_Quality Score %',
    'starRating': 'Modified Hwai Rating',
}


def _weighted_measures(frame, counties, payor, plan_type):
    keys = ['county_name', PAYOR_COL, 'Plan_Type']
    part = frame[frame['county_name'].isin(counties)]
    if payor:
        part = part[part[PAYOR_COL].isin(_as_list(payor))]
    if plan_type:
        part = part[part['Plan_Type'].isin(_as_list(plan_type))]
    part = part.drop_duplicates(subset=keys + ['PlanID'])
    out = {}
    for key, group in part.groupby(keys, sort=False):
        weight = pd.to_numeric(group[ENROLLMENT_COL], errors='coerce').fillna(0).clip(lower=0)
        values = {}
        for name, column in EXPLAIN_MEASURES.items():
            if column not in group.columns:
                continue
            series = pd.to_numeric(group[column], errors='coerce')
            mask = series.notna()
            if not mask.any():
                continue
            w = weight[mask]
            values[name] = float((series[mask] * w).sum() / w.sum()) if w.sum() > 0 else float(series[mask].mean())
        out[key] = values
    return out


def _county_measures(before, after, counties, payor, plan_type):
    """The scoped payor's measures before and after the drop, per county and plan type."""
    old = _weighted_measures(before, counties, payor, plan_type)
    new = _weighted_measures(after, counties, payor, plan_type)
    rows = []
    for key in sorted(set(old) | set(new)):
        rows.append({
            'county': _json_cell(key[0]),
            'payor': _json_cell(key[1]),
            'planType': _json_cell(key[2]),
            'before': old.get(key, {}),
            'after': new.get(key, {}),
        })
    return rows


def _affected_counties(ranked):
    fips = set(ranked.attrs.get('affected_fips') or [])
    if not fips:
        return []
    names = ranked[ranked[FIPS].isin(fips)]['county_name'].dropna().unique().tolist()
    return sorted(str(name) for name in names)


def _missing_lookups():
    needed = list(LK_FILES.values()) + [BASE_FINAL_FILE, BASE_RANKED_FILE]
    return [name for name in needed if not os.path.exists(LOOKUP_DIR + name)]


def _scenario_from_argv(argv):
    """sys.argv[1] payor, [2] plantype, [3] planId, [4] healthSystem, [5] physician group, [6] healthSystemIncrease, [7] physicianGroupIncrease, [8] county."""
    if len(argv) >= 2 and str(argv[1]).lstrip().startswith('{'):
        data = json.loads(argv[1])
        return {
            'payor': _blank(data.get('payor')),
            'plantype': _blank(data.get('plantype', data.get('planType'))),
            'planId': _blank(data.get('planId', data.get('plan_id'))),
            'healthSystem': _blank(data.get('healthSystem', data.get('health_system'))),
            'physicianGroup': _blank(data.get('physicianGroup', data.get('physician group'))),
            'healthSystemIncrease': _increase_flag(data.get('healthSystemIncrease')),
            'physicianGroupIncrease': _increase_flag(data.get('physicianGroupIncrease', data.get('physicainGroupIncrease'))),
            'county': _blank(data.get('county')),
        }
    slots = list(argv[1:]) + [''] * 8
    return {
        'payor': _blank(slots[0]),
        'plantype': _blank(slots[1]),
        'planId': _blank(slots[2]),
        'healthSystem': _blank(slots[3]),
        'physicianGroup': _blank(slots[4]),
        'healthSystemIncrease': _increase_flag(slots[5]) if _blank(slots[3]) else None,
        'physicianGroupIncrease': _increase_flag(slots[6]) if _blank(slots[4]) else None,
        'county': _blank(slots[7]),
    }


def _emit(payload):
    print(json.dumps(payload))
    return payload


def run_cli(argv=None):
    """Read the chatbot arguments and print one JSON object. The last stdout line is that object."""
    argv = list(sys.argv if argv is None else argv)
    try:
        scenario = _scenario_from_argv(argv)
    except (ValueError, json.JSONDecodeError) as exc:
        return _emit({'ok': False, 'error': str(exc)})

    payor, plan_type, plan_id = scenario['payor'], scenario['plantype'], scenario['planId']
    scope_error = _scope_error(payor, plan_type, plan_id)
    if scope_error:
        return _emit({'ok': False, 'error': scope_error})

    health, group = scenario['healthSystem'], scenario['physicianGroup']
    if health and scenario['healthSystemIncrease'] is None:
        return _emit({'ok': False, 'error': 'healthSystemIncrease must be true (added) or false (removed).'})
    if group and scenario['physicianGroupIncrease'] is None:
        return _emit({'ok': False, 'error': 'physicianGroupIncrease must be true (added) or false (removed).'})
    if scenario['healthSystemIncrease'] is True or scenario['physicianGroupIncrease'] is True:
        return _emit({
            'ok': False,
            'error': 'This script recomputes a removal only. Set the increase flag to false to drop a health system or physician group.',
        })

    missing = _missing_lookups()
    if missing:
        return _emit({'ok': False, 'error': 'Lookup files are missing.', 'missing': missing, 'lookupDir': LOOKUP_DIR})

    county = scenario['county']
    before = current_rank(payor, plan_type, plan_id, county)
    drops = []
    if health:
        drops.append({'type': 'health_system', 'name': health, 'payor': payor, 'plan_type': plan_type, 'plan_id': plan_id})
    if group:
        drops.append({'type': 'group', 'name': group, 'payor': payor, 'plan_type': plan_type, 'plan_id': plan_id})
    ranked = run_scenario(drops) if drops else None
    after = rank_view(ranked, payor, plan_type, plan_id, county) if drops else before
    affected = _affected_counties(ranked) if drops else []
    shown = [county] if county else affected
    county_ranks = _county_ranks(_load_base()['base_ranked'], ranked, shown) if drops and shown else []
    county_measures = _county_measures(_load_base()['base_ranked'], ranked, shown, payor, plan_type) if drops and shown and payor else []
    rank_col = _rank_column(payor, plan_type, plan_id)
    return _emit({
        'ok': True,
        'rankColumn': rank_col,
        'scenario': {
            'payor': payor,
            'plantype': plan_type,
            'planId': plan_id,
            'healthSystem': health,
            'physicianGroup': group,
            'healthSystemIncrease': scenario['healthSystemIncrease'],
            'physicianGroupIncrease': scenario['physicianGroupIncrease'],
            'county': county,
        },
        'rows': _rows_payload(before, after, rank_col),
        'affectedCounties': affected,
        'countyRanks': county_ranks,
        'countyMeasures': county_measures,
    })


if __name__ == '__main__':
    try:
        run_cli()
    except Exception as exc:
        _emit({'ok': False, 'error': str(exc)})
        sys.exit(1)
