# Experience Planning v2

This document supersedes the earlier fixed 8km discovery rule for the active planner policy `experience-route-v2`.

## Product policy

- The system discovers POIs within a radius derived from the time budget and the fastest user-accepted travel mode. The discovery radius is not a validity rule.
- A route is valid when its verified route legs, stop durations, buffer, and explicit time policy fit the itinerary budget. A flexible time policy may use up to 30 additional minutes and must surface `PREFERENCE_RELAXED`.
- A POI can be a short connector and may have a stay duration as low as one minute. It is still included only when it improves the route's experience strategy.
- Explicit exclusions filter candidates. User must-haves, custom preferences, and standard interests are all included in route focus.

## Route diversity

The planner produces at most one route for each strategy, all under the same experience story:

| Strategy | Objective |
| --- | --- |
| Deep experience | Prioritizes the focus POI and longer time at fewer stops. |
| Neighborhood wander | Rewards category variety and a connected sequence of places. |
| Easy pace | Penalizes movement more strongly and leaves flexibility for a shorter route. |

Two selected routes may not share more than half of the smaller route's POIs. This prevents relabeling the same sequence as several options.

## Data quality boundary

Current route facts (coordinates and route legs) come from the configured map provider. Ranking, review, and curated-place signals must be ingested only from an authorized source; the application must not label a POI as ranking- or review-backed until that source is available.
## 地点粒度与最小路线数

路线生成以可定位的具体地点为核心：餐厅、店铺、展馆、景点和明确地标可作为停靠点；步行街、商圈、园区、街区等区域型 POI 仅可作为路线语境，默认不会作为第一站、唯一站或编辑候选。

每次成功生成至少返回两条差异明显、经过路网和时间校验的路线。若候选地点不足或无法形成两条路线，服务返回明确的不可生成错误，提示用户调整出发点、时长或偏好，而不再保存单路线降级结果。
