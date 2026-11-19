# -*- coding: utf-8 -*-
"""Collapse the HCA-dropped UnitedHealthcare ranked workbook into data/scenario_hca_united.csv.

One row per county, plan type, and payor. Rank is rank_payor_plantype.
The network score is the enrollment-weighted score that rank is based on
(Stage2_dynamic.rank_table). The network name is the payor's highest-enrollment plan.

Usage:
    py -3 scripts/import_hca_united_scenario.py "path/to/scenario_HCA_dropped_United_Harris_ranked.xlsx"
"""

import csv
import sys

import pandas as pd

source = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\RajeevRanjan\Downloads\scenario_HCA_dropped_United_Harris_ranked.xlsx"
destination = sys.argv[2] if len(sys.argv) > 2 else "data/scenario_hca_united.csv"

COLUMNS = [
    "county_name",
    "Parent_Organization",
    "Plan_Type",
    "network_name",
    "network_score",
    "July_2026",
    "rank_payor_plantype",
    "FIPS State County Code",
]

frame = pd.read_excel(source, sheet_name=0, usecols=COLUMNS)
frame = frame.dropna(subset=["county_name", "Parent_Organization", "Plan_Type", "rank_payor_plantype"])
frame = frame[frame["rank_payor_plantype"] > 0]
weight = frame["July_2026"].fillna(0).clip(lower=0)
weight = weight.where(frame["network_score"].notna(), 0)
frame = frame.assign(_w=weight, _ws=weight * frame["network_score"].fillna(0))

rows = []
keys = ["county_name", "Parent_Organization", "Plan_Type"]
for key, group in frame.groupby(keys, sort=False):
    county, payor, plan_type = key
    total_weight = float(group["_w"].sum())
    score = float(group["_ws"].sum() / total_weight) if total_weight > 0 else float(group["network_score"].mean())
    top = group.sort_values(["July_2026", "network_score"], ascending=False).iloc[0]
    fips = top["FIPS State County Code"]
    rows.append({
        "county": str(county).strip(),
        "state": "TX",
        "fips": "" if pd.isna(fips) else str(int(fips)),
        "payor": str(payor).strip(),
        "planType": str(plan_type).strip(),
        "metric": "Network score",
        "value": round(score, 8),
        "asOf": "2026",
        "network": "" if pd.isna(top["network_name"]) else str(top["network_name"]).strip(),
        "rank": int(group["rank_payor_plantype"].min()),
    })

rows.sort(key=lambda row: (row["county"], row["planType"], row["rank"], row["payor"]))
header = ["county", "state", "fips", "payor", "planType", "metric", "value", "asOf", "network", "rank"]
with open(destination, "w", newline="", encoding="utf-8") as handle:
    writer = csv.DictWriter(handle, fieldnames=header, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)

harris = [row for row in rows if row["county"].lower() == "harris" and "unitedhealth" in row["payor"].lower()]
print({"rows": len(rows), "destination": destination, "harrisUnited": harris})
