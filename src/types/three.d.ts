declare module "three" {
  export const Scene: any;
  export const Color: any;
  export const Fog: any;
  export const PerspectiveCamera: any;
  export const Group: any;
  export const HemisphereLight: any;
  export const AmbientLight: any;
  export const DirectionalLight: any;
  export const Mesh: any;
  export const InstancedMesh: any;
  export const Sprite: any;
  export const SpriteMaterial: any;
  export const Texture: any;
  export const Vector2: any;
  export const Vector3: any;
  export const Plane: any;
  export const Raycaster: any;
  export const Matrix4: any;
  export const BoxGeometry: any;
  export const PlaneGeometry: any;
  export const CylinderGeometry: any;
  export const ConeGeometry: any;
  export const SphereGeometry: any;
  export const TorusGeometry: any;
  export const OctahedronGeometry: any;
  export const MeshStandardMaterial: any;
  export const MeshBasicMaterial: any;
  export const MOUSE: any;
  export const SRGBColorSpace: any;
  export const PCFSoftShadowMap: any;
  export const ACESFilmicToneMapping: any;
  export const MathUtils: any;
}
declare module "three/addons/controls/OrbitControls.js" {
  export class OrbitControls {
    constructor(camera: any, element: HTMLElement);
    target: any;
    enableDamping: boolean;
    dampingFactor: number;
    enablePan: boolean;
    enableZoom: boolean;
    enableRotate: boolean;
    screenSpacePanning: boolean;
    rotateSpeed: number;
    panSpeed: number;
    minDistance: number;
    maxDistance: number;
    minPolarAngle: number;
    maxPolarAngle: number;
    mouseButtons: { LEFT: any; MIDDLE: any; RIGHT: any };
    update(): void;
    dispose(): void;
  }
}
