"""Small orthographic geometry preview for template QA, not a source-image edit."""
import argparse
from pathlib import Path
import sys
sys.dont_write_bytecode = True
import numpy as np
import trimesh
from PIL import Image, ImageDraw

def render(path, output):
    scene = trimesh.load(path, force='scene', process=False)
    width, height = 600, 900
    image = Image.new('RGB', (width*3, height), '#e3e7ea')
    draw = ImageDraw.Draw(image)
    palette = {'Head': [171,139,116], 'Skin':[171,139,116], 'Shirt':[110,118,126],
               'Pants':[61,70,84], 'Shoes':[45,43,42], 'Hair':[36,30,25], 'Eyes':[208,198,183]}
    for view, angle in enumerate([0, np.pi/2, np.pi]):
        c,s = np.cos(angle),np.sin(angle)
        camera = np.array([[c,0,-s],[0,1,0],[s,0,c]])
        triangles=[]
        for name, mesh in scene.geometry.items():
            points = mesh.vertices @ camera.T
            normals = mesh.face_normals @ camera.T
            shade = np.clip(normals @ np.array([.35,.5,.65]),-.15,1)*.55+.65
            for i, face in enumerate(mesh.faces):
                if normals[i,2]<-.1:
                    continue
                p=points[face]
                xy=np.column_stack([p[:,0]*450+view*width+width/2, height-55-p[:,1]*450])
                color=tuple(np.clip(np.array(palette.get(name,[170,170,170]))*shade[i],0,255).astype(int))
                triangles.append((p[:,2].mean(),xy,color))
        for _,xy,color in sorted(triangles,key=lambda t:t[0]):
            draw.polygon([tuple(p) for p in xy],fill=color)
        draw.text((view*width+20,20),['Front','Side','Back'][view], fill='#111111')
    image.save(output)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('path');p.add_argument('--output',default='.local/body-templates/preview.png')
    args=p.parse_args();render(args.path,args.output)
