# Slow Roads Traffic

An experimental traffic layer for [slowroads.io](https://slowroads.io/), written as a userscript and tested only with Tampermonkey.

I love Slow Roads. It is one of those rare browser projects that quietly sits in the background while I am thinking through hard problems. I often keep it open while making complex decisions, almost like a moving whiteboard. The official demo that showed traffic was not available to me on macOS, so I wanted to explore what it would take to place convincing ambient traffic into the live game from the outside.

This project is educational. It is not an official Slow Roads feature, not affiliated with the Slow Roads developer, and not meant to compete with the original game. It is a study of how traffic can be approximated when the only surface available is the rendered scene. If anything here is useful to the real game, the ideas are free to replicate properly inside the engine.

## What this does

The script adds simple generated traffic to Slow Roads:

- Cars and trucks that follow the road.
- Different driver classes: trucks, slow cars, normal cars, and faster cars.
- Lane side detection with a manual override.
- Speed classes and speed limit zones.
- Overtaking with indicators.
- Basic following behavior.
- Oncoming vehicle checks.
- Horns when the player is actually in the wrong lane.
- Collision assist that pushes traffic and the player apart.
- Police pursuit behavior for speeding.
- Speed limit signs.
- A small in-game settings panel.

The goal is not perfect realism. The goal is believability under heavy constraints.

## Installation

This has only been tested with Tampermonkey.

1. Install Tampermonkey in your browser.
2. Create a new userscript.
3. Paste the contents of [`src/slow-roads-traffic.user.js`](src/slow-roads-traffic.user.js).
4. Save it.
5. Open `https://slowroads.io/`.

Useful controls while in game:

- `Shift+T`: toggle traffic.
- `Shift+[`: fewer cars.
- `Shift+]`: more cars.
- `Shift+-`: slower traffic.
- `Shift+=`: faster traffic.
- `Shift+\`: flip driving side.

## Why a userscript

The interesting constraint is that this does not have access to the internal Slow Roads source code. It runs on the page and has to infer the world from what is already being rendered.

That creates a very different engineering problem from writing traffic inside a game engine. Inside the engine I would expect direct access to:

- The road spline.
- Lane definitions.
- Collision geometry.
- Vehicle transforms.
- Player input and vehicle physics.
- World streaming state.
- Traffic spawn volumes.
- Deterministic simulation ticks.

The userscript gets none of that cleanly. It has to observe Three.js objects, identify road meshes, reconstruct an approximate road centerline, and then run a lightweight traffic simulation against that reconstruction.

That is why this project is part traffic system and part scene archaeology.

## High level architecture

The script is built around five loops:

1. Capture enough Three.js objects to find the active scene.
2. Rebuild an approximate road path from visible road geometry.
3. Project the player and traffic vehicles onto that path.
4. Step traffic behavior in road coordinates.
5. Convert road coordinates back into world transforms.

Internally, almost everything is expressed in terms of `s`, the distance along the road centerline.

If the road centerline is a sampled polyline:

```text
P0, P1, P2, ... Pn
```

then the accumulated distance array is:

```text
S0 = 0
Si = S(i - 1) + length(Pi - P(i - 1))
```

A car is represented by:

```text
s       position along the road
dir     +1 or -1 along the road
v       current speed in meters per second
vBase   preferred speed in meters per second
laneCur current lane offset state
laneTarget desired lane offset state
phase   cruise, signal, pass, return
```

This is the core simplification. The simulation does not need a full 3D navigation mesh. It needs a stable one dimensional road coordinate, plus lateral offsets for lanes.

## Road reconstruction

The first hard problem is finding the road.

The script watches for Three.js meshes and looks for geometry with a `paintSolid` attribute. From that geometry it samples pairs of vertices that look like left and right road edges. Each pair gives a center point:

```text
C = (L + R) / 2
```

It rejects rows that look implausible:

```text
roadWidth < 3 meters
roadWidth > 25 meters
duplicate points
large jumps between rows
```

The remaining center points are grouped into segments. Segments are then chained by comparing endpoint distances. If the tail of one segment is close to the head of another, they are joined. If the orientation is reversed, the segment is reversed before joining.

This gives a rough road polyline that can be sampled by distance.

### Sampling the road

For a distance `s`, the script binary searches the accumulated distance array to find the containing segment:

```text
S[i] <= s <= S[i + 1]
```

Then it interpolates:

```text
t = (s - S[i]) / (S[i + 1] - S[i])
P(s) = P[i] + t * (P[i + 1] - P[i])
```

The tangent is estimated from neighboring points:

```text
T = normalize(P[i + 1] - P[i - 1])
```

The road right vector in the horizontal plane is:

```text
R = (-Tz, Tx)
```

That gives a local coordinate frame:

```text
worldPosition = P(s) + R * lateralOffset
```

## Projection

Projection is the inverse problem. Given a world position, find the nearest `s` on the road.

The coarse projection searches sampled road points. That is fast but can be quantized by road mesh density. For lane decisions, quantization errors of even 1 to 2 meters matter, because a lane is only a few meters wide.

So the script refines the projection with a tangent step:

```text
s' = s + dot(worldPosition - P(s), T(s))
```

Then it repeats the step a small number of times.

The signed lateral offset is:

```text
lat = dot(worldPosition - P(s), R(s))
```

This matters for two reasons:

1. It lets the script decide which side of the road the player is on.
2. It prevents false horn triggers where the player is near a lane but not actually inside it.

## Lane model

The lane system is intentionally simple.

Each car has:

```text
laneCur    current lane state
laneTarget target lane state
```

The usual lane is `+1`. The passing lane is `-1`. A value between them means the car is changing lanes.

The physical side of the lane depends on:

```text
sideSign * car.dir
```

`sideSign` is detected from the player when possible, or can be manually flipped. This lets the same code work for left side and right side driving.

The lateral offset is:

```text
offset = laneOffset * sideSign * car.dir * laneCur + jolt
```

This is not a real lane graph. It is a two lane approximation. But for a continuous road with one lane in each direction, it produces readable behavior.

## Driver classes

Traffic is sampled from a small class distribution:

```text
truck   probability 0.22, speed multiplier 0.55 to 0.75
slow    probability 0.22, speed multiplier 0.70 to 0.88
normal  probability 0.36, speed multiplier 0.88 to 1.08
fast    probability 0.20, speed multiplier 1.10 to 1.40
```

This is a cheap way to avoid a stream of identical vehicles. The important part is not the exact numbers. The important part is that each vehicle gets a persistent identity:

```text
aggression
reaction
gapMul
speedMul
```

Those values influence acceleration, braking, following distance, and overtaking decisions.

A real implementation should push this further. Driver identity should be a parameter vector, not a handful of random values:

```text
theta = [
  desiredSpeed,
  minTimeHeadway,
  maxAcceleration,
  comfortableBraking,
  politeness,
  riskTolerance,
  laneChangeLatency,
  perceptionNoise,
  routeIntent
]
```

The behavior planner can then read from `theta` instead of relying on hardcoded class branches.

## Speed selection

The target speed starts from the local speed limit:

```text
vBase = speedLimit(s) / 3.6 * speedMultiplier
```

There is also a small breathing term:

```text
vDesired = vBase * (1 + sin(t * f + phase) * epsilon)
```

This keeps cars from moving with identical clockwork speed. It is not meant to simulate a human foot perfectly. It is just enough to break visual uniformity.

## Curvature speed limit

Cars should slow down on tight bends.

The script estimates curvature by comparing two adjacent direction vectors:

```text
v1 = P(s) - P(s - ds)
v2 = P(s + ds) - P(s)
```

The approximate curvature is:

```text
kappa = abs(cross(v1, v2)) / (length(v1) * length(v2) * averageSegmentLength)
```

Then the curve limited speed is:

```text
vCurve = sqrt(aLatMax / max(kappa, epsilon))
```

This comes from:

```text
aLat = v^2 * kappa
v = sqrt(aLat / kappa)
```

The script uses a modest lateral acceleration limit so traffic does not fly through corners unrealistically.

The actual target speed becomes:

```text
vTarget = min(vDesired, vCurve)
```

Inside the real game, this could be improved with clothoid aware curve prediction, road banking, weather, tire grip, and vehicle type.

## Following model

The script uses a simple time headway rule.

Desired gap:

```text
gapDesired = (4 + v * reactionTime) * gapMultiplier
```

If the actual gap is smaller:

```text
vTarget = min(vTarget, leaderV + (gap - gapDesired) * brakeGain)
```

This is not a full Intelligent Driver Model, but it has the same basic shape: drive at your preferred speed unless the leader forces you to reduce speed.

A better in-engine model would use IDM directly:

```text
a = aMax * (1 - (v / v0)^delta - (sStar / s)^2)

sStar = s0 + vT + (v * deltaV) / (2 * sqrt(aMax * b))
```

Where:

```text
v      current speed
v0     desired speed
s      current gap
s0     minimum gap
T      desired time headway
deltaV closing speed
aMax   maximum acceleration
b      comfortable braking
```

That would give smoother stop and go behavior, better jam waves, and more stable traffic at higher densities.

## Overtaking

Overtaking is a small state machine:

```text
cruise -> signal -> pass -> return -> cruise
```

A car considers passing when:

```text
leader is close
leader is slower than my preferred speed
I am not cooling down from a previous pass
I am in my own lane
I am allowed to overtake
```

The estimated passing distance is:

```text
dv = max(minClosingSpeed, passSpeed - leaderSpeed)
passDist = (gap + carLength + clearance) * passSpeed / dv
```

That is a rough time to pass multiplied by the speed during the pass.

The script rejects the pass if:

```text
passDist is too large
road curvature ahead is too high
an oncoming vehicle will arrive within the required time
the player is in the opposing lane and close enough to matter
```

The oncoming check is:

```text
timeToConflict = distanceAlongRoad / max(1, mySpeed + otherSpeed)
```

If:

```text
timeToConflict < neededTime + safetyBuffer
```

then the pass is unsafe.

This is intentionally conservative. A userscript cannot trust its world model enough to make aggressive passing feel fair.

Inside the real game I would split overtaking into:

- A candidate generation stage.
- A risk scoring stage.
- A commitment stage.
- An abort stage.

The risk score could combine:

```text
risk = w1 * timeToCollisionRisk
     + w2 * blindCurveRisk
     + w3 * laneChangeGapRisk
     + w4 * playerUncertainty
     + w5 * speedDifferenceRisk
```

Then a driver with higher risk tolerance would accept a higher score. That creates personality without hand scripting every case.

## Collision behavior

The script cannot modify Slow Roads vehicle physics directly. So it implements collision behavior from its own side.

Each traffic vehicle is approximated as an oriented box. The player position is transformed into the car local frame:

```text
localX = dot(player - car, carLeft)
localZ = dot(player - car, carForward)
```

If:

```text
abs(localX) < expandedHalfWidth
abs(localZ) < expandedHalfLength
```

then there is overlap.

The smaller penetration axis determines the response:

- Longitudinal overlap pushes the traffic car forward or makes it yield.
- Lateral overlap applies a side jolt.
- The player is nudged away to prevent occupying the same space.

This is not real rigid body physics. It is a corrective constraint. It is closer to positional projection than to impulse based collision resolution.

A proper engine implementation should use:

```text
relativeVelocity = vA - vB
normalImpulse = -(1 + restitution) * dot(relativeVelocity, normal) / effectiveMass
tangentImpulse = clamp(frictionTerm)
```

But it should also avoid turning Slow Roads into a crash simulator. The tone of the game is calm. A good traffic system should preserve that.

## Police behavior

Police are mostly a gameplay experiment.

The player speed is estimated from position deltas:

```text
playerSpeed = distance(currentPosition, previousPosition) / dt
```

If:

```text
playerSpeedKmh > speedLimit + threshold
```

and the player is on the road, a chase can begin.

During a chase the police vehicle aims to stay behind the player:

```text
targetSpeed = clamp(max(limit * 1.25, playerSpeed + 5), lowerBound, upperBound)
```

If the player slows and pulls onto the shoulder, the chase ends.

This is not meant to be punitive. It is a small behavioral layer that makes speed limits matter.

In a proper version I would not write this as a special case. Police should be actors in the same behavior system with a different objective function:

```text
J = wProgress * progressError
  + wSafety * collisionRisk
  + wLaw * speedingViolation
  + wComfort * jerk
  + wPlayer * playerDistanceError
```

The planner would choose actions that minimize `J` over a short horizon.

## Spawning and retention

Traffic is spawned relative to the player:

- Some ahead in the same direction.
- Some behind in the same direction.
- Some ahead as oncoming traffic.

Spawn distances scale with player speed:

```text
minGapSame = max(90, playerSpeed * 3)
minGapOncoming = max(120, playerSpeed * 4)
```

The script avoids spawning vehicles too close to existing vehicles in the same direction.

Retention is more subtle. Slow Roads streams and rebuilds road geometry. If the script rebuilds the road path and projects a visible car to the wrong `s`, the car can appear to pop away. To reduce that, nearby cars are protected by world distance as well as road distance.

This is the hardest category of bug in the userscript: the road model is not authoritative. When the world rebuilds, the traffic system has to decide whether the new projection is true or just a transient artifact.

Inside the engine this problem almost disappears. Traffic should live in the same streaming coordinate system as the road. Vehicles should not be re-projected from rendered meshes every second. They should be attached to road segments with stable IDs.

## Why the intelligence feels better than random cars

Most of the illusion comes from small constraints working together:

- Cars have persistent speed preferences.
- Cars respect curvature.
- Cars maintain headway.
- Passing requires visibility and time.
- Lane changes are gradual.
- Horns require a lane intrusion condition.
- Police react to speeding rather than appearing randomly.
- Spawn distances scale with speed.
- Cars are protected from removal while visible.

None of these pieces is especially complex alone. The behavior becomes convincing because the system mostly avoids contradictions. A car does not overtake into a blind bend. A horn does not trigger unless the player is actually in the car's lane. A truck tends to behave differently from a fast car. A vehicle close to the camera is not casually deleted.

That is the main design lesson: traffic intelligence is less about making every car clever, and more about removing the moments where the simulation admits that it is fake.

## Limitations

This is still a userscript. The limitations are real.

- It depends on Slow Roads scene internals that may change.
- Road extraction is inferred from rendered geometry.
- There is no true collision integration with the player's vehicle.
- The vehicles are simple generated meshes.
- There is no route planning.
- There are no intersections.
- There is no traffic density model.
- There is no persistent world state across far distances.
- There is no deterministic replay.
- There is no real sensor model.
- There is no multiplayer awareness.
- It has only been tested with Tampermonkey.

The script can look surprisingly alive, but it is still running beside the game rather than inside it.

## How I would implement this properly in Slow Roads

If this were built into the real game, I would start with a road native architecture.

### 1. Stable road graph

Represent roads as a graph:

```text
RoadSegment {
  id
  centerSpline
  lanes
  speedLimit
  curvatureProfile
  gradeProfile
  spawnHints
}

Lane {
  id
  direction
  width
  allowedVehicleTypes
  neighborLeft
  neighborRight
}
```

Each vehicle stores:

```text
segmentId
laneId
s
lateralOffset
speed
intent
```

This avoids reverse engineering from meshes and makes streaming robust.

### 2. Two layer simulation

Use two layers:

```text
macroscopic layer: density, flow, spawn rates
microscopic layer: individual car behavior near the player
```

Far away cars do not need full physics. They can be represented as flow values:

```text
q = density * averageSpeed
```

Near the player, instantiate individual vehicles and simulate them in detail.

This keeps CPU cost bounded while still producing local realism.

### 3. Behavior planner

Each car should run a compact behavior planner:

```text
perceive -> predict -> score actions -> commit -> control
```

Candidate actions:

```text
keep lane
slow down
follow leader
prepare pass
change lane left
change lane right
abort pass
pull over
despawn gracefully
```

Each action is scored over a short horizon:

```text
score(action) = safetyCost
              + progressCost
              + comfortCost
              + ruleCost
              + personalityCost
```

Safety should dominate progress. A fast driver can accept a smaller comfort margin, but should not ignore collision time.

### 4. Better car following

Use IDM or a related model for longitudinal control.

The acceleration command:

```text
a = aMax * (1 - (v / v0)^delta - (sStar / s)^2)
```

This gives smooth acceleration and braking, and it naturally creates traffic waves at high density.

### 5. MOBIL style lane changes

For lane changes, use something like MOBIL:

```text
benefit = myNewAcceleration - myOldAcceleration
          + politeness * (newFollowerAccelerationLoss + oldFollowerAccelerationGain)

safe = newFollowerAcceleration > -safeBrakingLimit
```

Then:

```text
changeLane if safe and benefit > threshold
```

This is a better foundation than hand tuning pass conditions. It lets the system reason about how a lane change affects nearby vehicles, not just the actor making the move.

### 6. Player aware uncertainty

The player should be treated as a high uncertainty actor.

For AI vehicles:

```text
playerPredictionVariance > trafficPredictionVariance
```

That means larger buffers, earlier aborts, and fewer aggressive passes around the player.

This matters because players are not bound by the same behavioral rules as traffic.

### 7. Comfort and tone

Slow Roads has a specific feeling. Traffic should support it.

I would optimize for:

- Calm density.
- Long sightlines.
- Few surprise stops.
- No chaotic weaving.
- Soft recovery from conflicts.
- Minimal punishment.

The traffic should make the road feel inhabited, not stressful.

## Repository status

This is a private experimental repo for a Tampermonkey tested userscript.

The source is in:

```text
src/slow-roads-traffic.user.js
```

No build step is required.

## Credits

Slow Roads is the work of its original developer. This repository is just an educational experiment inspired by how much I enjoy the game.

