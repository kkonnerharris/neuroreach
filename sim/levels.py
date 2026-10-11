"""Everyday-task levels: what an EEG headset plus an assistive robot arm could do for someone.

Each step names the brain command that triggers it (the motor imagery an EEG headset can
pick up) and the action the arm takes. The browser shows the same text, fetched from
/api/levels, so this file is the single source of truth.

Home scenes: the PyBullet ground plane is the table top; the robot is mounted on the far
side of the table and the person sits on the near side (+x), looking at it.
"""

LEVELS = [
    {
        "id": "coffee", "chapter": "Morning routine", "par": 25, "title": "Morning coffee", "icon": "☕", "scene": "home",
        "story": "Your hands can't grip today. Your EEG headset can still read what you intend.",
        "objects": [
            {"name": "mug", "shape": "cylinder", "size": [0.04, 0.1], "pos": [0.3, 0.5], "rgba": [0.95, 0.95, 0.93, 1], "mass": 0.3},
        ],
        "steps": [
            {"cmd": "right", "say": "Pick up the mug", "think": "Imagine squeezing your right hand", "do": ["pick", "mug"]},
            {"cmd": "feet", "say": "Bring it to me", "think": "Imagine pressing down with both feet", "do": ["handoff", 0.3]},
        ],
    },
    {
        "id": "breakfast", "chapter": "Morning routine", "par": 30, "title": "Breakfast", "icon": "🍎", "scene": "home",
        "story": "Breakfast is across the table. Move it with your intentions, one step at a time.",
        "objects": [
            {"name": "apple", "shape": "sphere", "size": [0.038], "pos": [0.25, -0.5], "rgba": [0.8, 0.1, 0.12, 1], "mass": 0.15},
            {"name": "plate", "shape": "cylinder", "size": [0.11, 0.016], "pos": [0.62, -0.18], "rgba": [0.97, 0.97, 0.95, 1], "static": True},
        ],
        "steps": [
            {"cmd": "left", "say": "Pick up the apple", "think": "Imagine squeezing your left hand", "do": ["pick", "apple"]},
            {"cmd": "right", "say": "Put it on my plate", "think": "Imagine squeezing your right hand", "do": ["place", "plate"]},
        ],
    },
    {
        "id": "lamp", "chapter": "Morning routine", "par": 25, "title": "Lights", "icon": "💡", "scene": "home",
        "story": "It's getting dark. Turn on the lamp without moving.",
        "objects": [
            {"name": "lamp", "shape": "cylinder", "size": [0.07, 0.04], "pos": [0.28, 0.55], "rgba": [0.2, 0.2, 0.22, 1], "static": True},
        ],
        "steps": [
            {"cmd": "fists", "say": "Turn on the lamp", "think": "Imagine squeezing both hands", "do": ["press", "lamp"], "then": "lamp_on"},
            {"cmd": "rest", "say": "Relax, nothing should move", "think": "Just relax and think of nothing", "do": ["wait"]},
        ],
    },
    {
        "id": "phone", "chapter": "Morning routine", "par": 30, "title": "Phone call", "icon": "📱", "scene": "home",
        "story": "Your phone is ringing on the far side of the table.",
        "objects": [
            {"name": "phone", "shape": "box", "size": [0.038, 0.075, 0.006], "pos": [0.22, 0.52], "rgba": [0.08, 0.08, 0.09, 1], "mass": 0.18},
        ],
        "steps": [
            {"cmd": "right", "say": "Pick up the phone", "think": "Imagine squeezing your right hand", "do": ["pick", "phone"]},
            {"cmd": "feet", "say": "Bring it to my ear", "think": "Imagine pressing down with both feet", "do": ["handoff", 0.42]},
        ],
    },
    {
        "id": "medicine", "title": "Medicine", "icon": "💊", "scene": "home", "chapter": "Around the house", "par": 30,
        "story": "It's 9 o'clock: time for your pills. They're out of reach on the far side.",
        "objects": [
            {"name": "pills", "shape": "cylinder", "size": [0.028, 0.08], "pos": [0.22, -0.52], "rgba": [0.95, 0.55, 0.15, 1], "mass": 0.12},
        ],
        "steps": [
            {"cmd": "left", "say": "Pick up the pill bottle", "think": "Imagine squeezing your left hand", "do": ["pick", "pills"]},
            {"cmd": "feet", "say": "Bring it to me", "think": "Imagine pressing down with both feet", "do": ["handoff", 0.3]},
        ],
    },
    {
        "id": "tidy", "title": "Tidy up", "icon": "📚", "scene": "home", "chapter": "Around the house", "par": 55,
        "story": "Guests are coming. Put things back where they belong.",
        "objects": [
            {"name": "book", "shape": "box", "size": [0.07, 0.1, 0.015], "pos": [0.32, 0.48], "rgba": [0.2, 0.35, 0.6, 1], "mass": 0.3},
            {"name": "stack", "shape": "box", "size": [0.08, 0.11, 0.05], "pos": [-0.15, 0.58], "rgba": [0.6, 0.2, 0.2, 1], "static": True},
            {"name": "remote", "shape": "box", "size": [0.022, 0.075, 0.01], "pos": [0.55, -0.22], "rgba": [0.1, 0.1, 0.11, 1], "mass": 0.12},
            {"name": "tray", "shape": "box", "size": [0.09, 0.13, 0.008], "pos": [-0.12, -0.58], "rgba": [0.5, 0.36, 0.22, 1], "static": True},
        ],
        "steps": [
            {"cmd": "right", "say": "Pick up the book", "think": "Imagine squeezing your right hand", "do": ["pick", "book"]},
            {"cmd": "fists", "say": "Put it on the stack", "think": "Imagine squeezing both hands", "do": ["place", "stack"]},
            {"cmd": "left", "say": "Pick up the TV remote", "think": "Imagine squeezing your left hand", "do": ["pick", "remote"]},
            {"cmd": "feet", "say": "Drop it in the tray", "think": "Imagine pressing down with both feet", "do": ["place", "tray"]},
        ],
    },
    {
        "id": "tv", "title": "TV time", "icon": "📺", "scene": "home", "chapter": "Around the house", "par": 25,
        "story": "Your show starts in a minute. The remote is across the table.",
        "objects": [
            {"name": "remote", "shape": "box", "size": [0.022, 0.075, 0.01], "pos": [0.3, -0.5], "rgba": [0.1, 0.1, 0.11, 1], "static": True},
        ],
        "steps": [
            {"cmd": "fists", "say": "Press the power button", "think": "Imagine squeezing both hands", "do": ["press", "remote"], "then": "tv"},
            {"cmd": "rest", "say": "Relax and enjoy the show", "think": "Just relax and think of nothing", "do": ["wait"]},
        ],
    },
    {
        "id": "table", "title": "Set the table", "icon": "🍽️", "scene": "home", "chapter": "Around the house", "par": 60,
        "story": "Lunch time. Fruit goes in the bowl, the glass goes on your coaster.",
        "objects": [
            {"name": "apple", "shape": "sphere", "size": [0.036], "pos": [0.2, 0.52], "rgba": [0.85, 0.65, 0.1, 1], "mass": 0.15},
            {"name": "bowl", "shape": "cylinder", "size": [0.07, 0.035], "pos": [-0.18, 0.55], "rgba": [0.9, 0.9, 0.88, 1], "static": True},
            {"name": "glass", "shape": "cylinder", "size": [0.032, 0.11], "pos": [0.28, -0.5], "rgba": [0.8, 0.9, 1.0, 1], "mass": 0.25},
            {"name": "coaster", "shape": "cylinder", "size": [0.05, 0.006], "pos": [0.66, 0.16], "rgba": [0.35, 0.28, 0.22, 1], "static": True},
        ],
        "steps": [
            {"cmd": "right", "say": "Pick up the fruit", "think": "Imagine squeezing your right hand", "do": ["pick", "apple"]},
            {"cmd": "fists", "say": "Put it in the bowl", "think": "Imagine squeezing both hands", "do": ["place", "bowl"]},
            {"cmd": "left", "say": "Pick up the glass", "think": "Imagine squeezing your left hand", "do": ["pick", "glass"]},
            {"cmd": "feet", "say": "Put it on my coaster", "think": "Imagine pressing down with both feet", "do": ["place", "coaster"]},
        ],
    },
    {
        "id": "charge", "title": "Charge your phone", "icon": "🔌", "scene": "home", "chapter": "Afternoon", "par": 30,
        "story": "Battery at 5%. Put the phone on the charger.",
        "objects": [
            {"name": "phone", "shape": "box", "size": [0.038, 0.075, 0.006], "pos": [0.25, 0.5], "rgba": [0.08, 0.08, 0.09, 1], "mass": 0.18},
            {"name": "charger", "shape": "cylinder", "size": [0.055, 0.01], "pos": [0.62, 0.22], "rgba": [0.95, 0.95, 0.95, 1], "static": True},
        ],
        "steps": [
            {"cmd": "right", "say": "Pick up the phone", "think": "Imagine squeezing your right hand", "do": ["pick", "phone"]},
            {"cmd": "fists", "say": "Put it on the charger", "think": "Imagine squeezing both hands", "do": ["place", "charger"], "then": "charging"},
        ],
    },
    {
        "id": "plant", "title": "Water the plant", "icon": "🌱", "scene": "home", "chapter": "Afternoon", "par": 35,
        "story": "Your plant is drooping. Give it a drink.",
        "objects": [
            {"name": "can", "shape": "box", "size": [0.035, 0.06, 0.05], "pos": [0.26, -0.5], "rgba": [0.95, 0.95, 0.93, 1], "mass": 0.3},
            {"name": "plant", "shape": "cylinder", "size": [0.07, 0.11], "pos": [-0.18, 0.56], "rgba": [0.75, 0.45, 0.3, 1], "static": True},
        ],
        "steps": [
            {"cmd": "left", "say": "Pick up the watering can", "think": "Imagine squeezing your left hand", "do": ["pick", "can"]},
            {"cmd": "fists", "say": "Water the plant", "think": "Imagine squeezing both hands", "do": ["pour", "plant"], "then": "watered"},
        ],
    },
    {
        "id": "keys", "title": "Grab your keys", "icon": "🔑", "scene": "home", "chapter": "Afternoon", "par": 30,
        "story": "Your ride is outside. Where are your keys?",
        "objects": [
            {"name": "keys", "shape": "box", "size": [0.03, 0.045, 0.008], "pos": [0.3, 0.5], "rgba": [0.75, 0.6, 0.3, 1], "mass": 0.08},
        ],
        "steps": [
            {"cmd": "right", "say": "Pick up the keys", "think": "Imagine squeezing your right hand", "do": ["pick", "keys"]},
            {"cmd": "feet", "say": "Hand them to me", "think": "Imagine pressing down with both feet", "do": ["handoff", 0.3]},
        ],
    },
    {
        "id": "dog", "title": "Treat for the dog", "icon": "🐶", "scene": "home", "chapter": "Afternoon", "par": 35,
        "story": "Someone has been a very good dog.",
        "objects": [
            {"name": "treat", "shape": "box", "size": [0.025, 0.012, 0.012], "pos": [0.24, -0.5], "rgba": [0.7, 0.45, 0.2, 1], "mass": 0.05},
            {"name": "dogbowl", "shape": "cylinder", "size": [0.08, 0.03], "pos": [0.64, -0.3], "rgba": [0.8, 0.8, 0.82, 1], "static": True},
        ],
        "steps": [
            {"cmd": "left", "say": "Pick up the dog treat", "think": "Imagine squeezing your left hand", "do": ["pick", "treat"]},
            {"cmd": "right", "say": "Drop it in the dog bowl", "think": "Imagine squeezing your right hand", "do": ["place", "dogbowl"], "then": "fed"},
        ],
    },
    {
        "id": "work", "chapter": "Work", "par": 70, "title": "Back to work", "icon": "📦", "scene": "packing",
        "story": "At work you pack computers into shipping boxes, all with your EEG headset.",
        "objects": [],
        "steps": [
            {"cmd": "left", "say": "Pack this computer in Box A", "think": "Imagine squeezing your left hand", "do": ["pack", "left"]},
            {"cmd": "right", "say": "Pack this computer in Box B", "think": "Imagine squeezing your right hand", "do": ["pack", "right"]},
            {"cmd": "right", "say": "Pack this one in Box B too", "think": "Imagine squeezing your right hand", "do": ["pack", "right"]},
            {"cmd": "left", "say": "Last one: Box A", "think": "Imagine squeezing your left hand", "do": ["pack", "left"]},
        ],
    },
    {
        "id": "rush", "title": "Rush hour", "icon": "⏱️", "scene": "packing", "chapter": "Work", "par": 100,
        "story": "Orders are piling up. Six computers, beat the clock.",
        "objects": [],
        "steps": [
            {"cmd": "right", "say": "Box B", "think": "Imagine squeezing your right hand", "do": ["pack", "right"]},
            {"cmd": "left", "say": "Box A", "think": "Imagine squeezing your left hand", "do": ["pack", "left"]},
            {"cmd": "left", "say": "Box A again", "think": "Imagine squeezing your left hand", "do": ["pack", "left"]},
            {"cmd": "right", "say": "Box B", "think": "Imagine squeezing your right hand", "do": ["pack", "right"]},
            {"cmd": "left", "say": "Box A", "think": "Imagine squeezing your left hand", "do": ["pack", "left"]},
            {"cmd": "right", "say": "Last one: Box B", "think": "Imagine squeezing your right hand", "do": ["pack", "right"]},
        ],
    },
]
BY_ID = {lv["id"]: lv for lv in LEVELS}
