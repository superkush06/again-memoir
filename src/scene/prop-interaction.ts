import * as THREE from "three";

export interface InteractiveMemoryProp {
  id: string;
  label: string;
  group: THREE.Group;
  movable: boolean;
}

/** Grabs preserve world transforms and return to the original parent on release.
 * Video props are immutable even when playback is paused. */
export class PropInteraction {
  private readonly held = new Map<THREE.Object3D, InteractiveMemoryProp>();
  private readonly initial: {
    prop: InteractiveMemoryProp;
    parent: THREE.Object3D;
    position: THREE.Vector3;
    rotation: THREE.Quaternion;
    scale: THREE.Vector3;
  }[];

  constructor(readonly props: InteractiveMemoryProp[]) {
    this.initial = props.flatMap((prop) =>
      prop.group.parent
        ? [
            {
              prop,
              parent: prop.group.parent,
              position: prop.group.position.clone(),
              rotation: prop.group.quaternion.clone(),
              scale: prop.group.scale.clone(),
            },
          ]
        : [],
    );
  }

  pick(ray: THREE.Raycaster, maxDistance = 4) {
    const candidates = this.props.filter(
      (prop) =>
        prop.movable &&
        prop.group.visible &&
        ![...this.held.values()].includes(prop),
    );
    for (const prop of candidates) prop.group.updateWorldMatrix(true, true);
    for (const hit of ray.intersectObjects(
      candidates.map((prop) => prop.group),
      true,
    )) {
      if (hit.distance > maxDistance) break;
      let object: THREE.Object3D | null = hit.object;
      while (object) {
        const prop = candidates.find((candidate) => candidate.group === object);
        if (prop) return { prop, point: hit.point };
        object = object.parent;
      }
    }
    return undefined;
  }

  grab(prop: InteractiveMemoryProp, anchor: THREE.Object3D) {
    if (
      !prop.movable ||
      !this.initial.some((item) => item.prop === prop) ||
      this.held.has(anchor) ||
      [...this.held.values()].includes(prop)
    )
      return false;
    anchor.updateWorldMatrix(true, false);
    prop.group.updateWorldMatrix(true, true);
    anchor.attach(prop.group);
    this.held.set(anchor, prop);
    return true;
  }

  holding(anchor: THREE.Object3D) {
    return this.held.get(anchor);
  }

  release(anchor: THREE.Object3D) {
    const prop = this.held.get(anchor);
    if (!prop) return;
    this.initial.find((item) => item.prop === prop)!.parent.attach(prop.group);
    this.held.delete(anchor);
    prop.group.userData.memoryPropMoved = true;
    prop.group.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(prop.group);
    if (!bounds.isEmpty() && bounds.min.y < 0.015) {
      const position = prop.group.getWorldPosition(new THREE.Vector3());
      position.y += 0.015 - bounds.min.y;
      prop.group.position.copy(prop.group.parent!.worldToLocal(position));
    }
    prop.group.updateWorldMatrix(true, true);
  }

  releaseAll() {
    for (const anchor of [...this.held.keys()]) this.release(anchor);
  }

  reset() {
    this.releaseAll();
    for (const item of this.initial) {
      if (!item.prop.movable) continue;
      item.prop.group.position.copy(item.position);
      item.prop.group.quaternion.copy(item.rotation);
      item.prop.group.scale.copy(item.scale);
      item.prop.group.userData.memoryPropMoved = false;
      item.prop.group.updateWorldMatrix(true, true);
    }
  }
}
